import { mkdtempSync, rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyInstance } from 'fastify';
import { RawData, WebSocket } from 'ws';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRelayApp } from '../src/app.js';
import { RelayLimits } from '../src/limits.js';
import { ConnectionRegistry } from '../src/routing/registry.js';
import { openRelayStore } from '../src/storage/sqlite-store.js';
import { RelayStore } from '../src/storage/store.js';

interface Credential {
  deviceId: string;
  deviceToken: string;
}

let dir: string;
let store: RelayStore;
let registry: ConnectionRegistry;
let app: FastifyInstance | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-app-int-'));
  store = openRelayStore(dir);
  registry = new ConnectionRegistry();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await new Promise((resolve) => setTimeout(resolve, 50));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function startApp(
  limits: Partial<RelayLimits> = {},
): Promise<{ httpUrl: string; wsUrl: string }> {
  app = await createRelayApp({ store, registry, logger: false, limits });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}`,
  };
}

function createDesktopCredential(username = 'alice'): Credential {
  const account =
    store.findAccountByUsername(username) ?? store.createAccount(username, 'pw-123456');
  const created = store.createDevice({
    accountId: account.accountId,
    role: 'desktop',
    deviceName: `${username} Mac`,
    platform: 'macos',
    appVersion: '1.0.0',
  });
  return { deviceId: created.device.deviceId, deviceToken: created.deviceToken };
}

function createPhoneCredential(username = 'alice'): Credential {
  const account =
    store.findAccountByUsername(username) ?? store.createAccount(username, 'pw-123456');
  const created = store.createDevice({
    accountId: account.accountId,
    role: 'phone',
    deviceName: `${username} iPhone`,
    platform: 'ios',
    appVersion: '1.0.0',
  });
  return { deviceId: created.device.deviceId, deviceToken: created.deviceToken };
}

function bearerOf(credential: Credential): string {
  return `Bearer ${credential.deviceId}.${credential.deviceToken}`;
}

async function errorCodeOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

function connectWs(
  url: string,
  authHeader?: string,
  options: { autoPong?: boolean } = {},
): Promise<
  { ok: true; socket: WebSocket } | { ok: false; status: number }
> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, {
      ...(authHeader === undefined
        ? {}
        : { headers: { authorization: authHeader } }),
      ...(options.autoPong === undefined ? {} : { autoPong: options.autoPong }),
    });
    socket.once('open', () => resolve({ ok: true, socket }));
    socket.once('unexpected-response', (_request, response) => {
      resolve({ ok: false, status: response.statusCode ?? -1 });
    });
    socket.once('error', () => resolve({ ok: false, status: -1 }));
  });
}

async function openDesktop(
  wsUrl: string,
  credential: Credential,
): Promise<{ socket: WebSocket; next: () => Promise<Record<string, unknown>> }> {
  const connected = await connectWs(`${wsUrl}/v1/desktop/ws`, bearerOf(credential));
  if (!connected.ok) throw new Error(`desktop connect failed: ${connected.status}`);
  const socket = connected.socket;
  const queue: Array<Record<string, unknown>> = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  socket.on('message', (data: RawData) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(message);
      return;
    }
    queue.push(message);
  });
  socket.send(
    JSON.stringify({
      type: 'desktop.hello',
      payload: {
        supportedContractVersions: [1],
        appVersion: '1.0.0',
        desktopName: 'Int Mac',
        platform: 'macos',
        handshakeId: 'hs_int',
      },
    }),
  );
  const next = (): Promise<Record<string, unknown>> => {
    const queued = queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  };
  const ready = await next();
  if (ready['type'] !== 'desktop.ready') {
    throw new Error(`expected ready, got ${JSON.stringify(ready)}`);
  }
  return { socket, next };
}

describe('手机升级校验（进程内）', () => {
  it('401 / 400 / 404 / 503 各分支', async () => {
    const { wsUrl } = await startApp();
    const phone = createPhoneCredential('alice');
    const aliceDesktop = createDesktopCredential('alice');
    const alicePhone2 = createPhoneCredential('alice');
    const bobDesktop = createDesktopCredential('bob');

    const unauthenticated = await connectWs(
      `${wsUrl}/ws?desktopId=${aliceDesktop.deviceId}`,
    );
    expect(unauthenticated).toEqual({ ok: false, status: 401 });

    const missing = await connectWs(`${wsUrl}/ws`, bearerOf(phone));
    expect(missing).toEqual({ ok: false, status: 400 });

    const phoneAsDesktop = await connectWs(
      `${wsUrl}/ws?desktopId=${alicePhone2.deviceId}`,
      bearerOf(phone),
    );
    expect(phoneAsDesktop).toEqual({ ok: false, status: 404 });

    const crossAccount = await connectWs(
      `${wsUrl}/ws?desktopId=${bobDesktop.deviceId}`,
      bearerOf(phone),
    );
    expect(crossAccount).toEqual({ ok: false, status: 404 });

    const offline = await connectWs(
      `${wsUrl}/ws?desktopId=${aliceDesktop.deviceId}`,
      bearerOf(phone),
    );
    expect(offline).toEqual({ ok: false, status: 503 });
  });
});

describe('通道生命周期（进程内）', () => {
  it('control 打开/收发/关闭；asr 二进制往返', async () => {
    const { wsUrl } = await startApp();
    const desktopCredential = createDesktopCredential();
    const phone = createPhoneCredential();
    const desktop = await openDesktop(wsUrl, desktopCredential);

    const control = await connectWs(
      `${wsUrl}/ws?desktopId=${desktopCredential.deviceId}`,
      bearerOf(phone),
    );
    if (!control.ok) throw new Error('control upgrade failed');
    const open = await desktop.next();
    expect(open['type']).toBe('channel.open');
    const channelId = (open['payload'] as { channelId: string }).channelId;

    control.socket.send('ping-text');
    const data = await desktop.next();
    expect(data).toMatchObject({
      type: 'channel.data',
      payload: { binary: false, data: 'ping-text' },
    });

    desktop.socket.send(
      JSON.stringify({
        type: 'channel.data',
        payload: { channelId, binary: false, data: 'pong-text' },
      }),
    );
    const received = await new Promise<string>((resolve) => {
      control.socket.once('message', (payload) => resolve(payload.toString()));
    });
    expect(received).toBe('pong-text');

    const channelClosed = desktop.next();
    control.socket.close(1000);
    expect(await channelClosed).toMatchObject({
      type: 'channel.close',
      payload: { channelId, code: 1000 },
    });

    const asr = await connectWs(
      `${wsUrl}/ws/asr?desktopId=${desktopCredential.deviceId}`,
      bearerOf(phone),
    );
    if (!asr.ok) throw new Error('asr upgrade failed');
    const asyncOpen = await desktop.next();
    const asrChannelId = (asyncOpen['payload'] as { channelId: string }).channelId;
    const pcm = Buffer.from([1, 2, 3, 4]);
    asr.socket.send(pcm);
    const forwarded = await desktop.next();
    expect(
      Buffer.from(
        (forwarded['payload'] as { data: string }).data,
        'base64',
      ).equals(pcm),
    ).toBe(true);

    desktop.socket.send(
      JSON.stringify({
        type: 'channel.close',
        payload: { channelId: asrChannelId, code: 4000, reason: 'done' },
      }),
    );
    const asrClosed = await new Promise<number>((resolve) => {
      asr.socket.once('close', (code: number) => resolve(code));
    });
    expect(asrClosed).toBe(4000);
  });
});

describe('HTTP 代答（进程内）', () => {
  it('成功代答、body 超限 413、未知路由 404、非法参数 404', async () => {
    const { httpUrl, wsUrl } = await startApp({ httpBodyBytes: 512 });
    const desktopCredential = createDesktopCredential();
    const phone = createPhoneCredential();
    const desktop = await openDesktop(wsUrl, desktopCredential);

    const viaProxy = fetch(
      `${httpUrl}/v1/attachments?desktopId=${desktopCredential.deviceId}`,
      {
        method: 'POST',
        headers: {
          authorization: bearerOf(phone),
          'content-type': 'application/json',
        },
        body: '{"image":"x"}',
      },
    );
    const request = await desktop.next();
    const payload = request['payload'] as Record<string, string>;
    desktop.socket.send(
      JSON.stringify({
        type: 'http.response',
        payload: {
          requestId: payload['requestId'],
          status: 201,
          contentType: 'application/json',
          bodyBase64: Buffer.from('{"ok":true}').toString('base64'),
        },
      }),
    );
    const response = await viaProxy;
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });

    const tooLarge = await fetch(
      `${httpUrl}/v1/attachments?desktopId=${desktopCredential.deviceId}`,
      {
        method: 'POST',
        headers: {
          authorization: bearerOf(phone),
          'content-type': 'application/json',
        },
        body: 'x'.repeat(600),
      },
    );
    expect(tooLarge.status).toBe(413);
    expect(await errorCodeOf(tooLarge)).toBe('BODY_TOO_LARGE');

    const unknownRoute = await fetch(`${httpUrl}/v1/pairings`, {
      headers: { authorization: bearerOf(phone) },
    });
    expect(unknownRoute.status).toBe(404);
    expect(await errorCodeOf(unknownRoute)).toBe('ROUTE_NOT_FOUND');

    const badParam = await fetch(
      `${httpUrl}/v1/approvals/bad!id/content?desktopId=${desktopCredential.deviceId}`,
      { headers: { authorization: bearerOf(phone) } },
    );
    expect(badParam.status).toBe(404);
    expect(await errorCodeOf(badParam)).toBe('ROUTE_NOT_FOUND');
  });

  it('超时 504、响应超限 502、离线 503、未鉴权 401', async () => {
    const { httpUrl, wsUrl } = await startApp({
      httpBodyBytes: 512,
      httpTimeoutMs: 100,
    });
    const desktopCredential = createDesktopCredential();
    const phone = createPhoneCredential();
    const desktop = await openDesktop(wsUrl, desktopCredential);

    const timeout = await fetch(
      `${httpUrl}/v1/runs/run_1/prompt?desktopId=${desktopCredential.deviceId}`,
      { headers: { authorization: bearerOf(phone) } },
    );
    expect(timeout.status).toBe(504);
    expect(await errorCodeOf(timeout)).toBe('GATEWAY_TIMEOUT');
    await desktop.next();

    const oversized = fetch(
      `${httpUrl}/v1/runs/run_2/prompt?desktopId=${desktopCredential.deviceId}`,
      { headers: { authorization: bearerOf(phone) } },
    );
    const request = await desktop.next();
    desktop.socket.send(
      JSON.stringify({
        type: 'http.response',
        payload: {
          requestId: (request['payload'] as Record<string, string>)['requestId'],
          status: 200,
          bodyBase64: Buffer.alloc(600).toString('base64'),
        },
      }),
    );
    const oversizedResponse = await oversized;
    expect(oversizedResponse.status).toBe(502);
    expect(await errorCodeOf(oversizedResponse)).toBe('GATEWAY_ERROR');

    desktop.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const offline = await fetch(
      `${httpUrl}/v1/runs/run_3/prompt?desktopId=${desktopCredential.deviceId}`,
      { headers: { authorization: bearerOf(phone) } },
    );
    expect(offline.status).toBe(503);

    const unauthenticated = await fetch(
      `${httpUrl}/v1/attachments?desktopId=${desktopCredential.deviceId}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(unauthenticated.status).toBe(401);
  });
});

describe('取代与代次隔离（C1/I1/I2）', () => {
  it('桌面被取代：旧链路手机立即 4010，且旧代次无法向新通道注入数据', async () => {
    const { wsUrl } = await startApp();
    const desktopCredential = createDesktopCredential();
    const phone = createPhoneCredential();
    const first = await openDesktop(wsUrl, desktopCredential);

    const control1 = await connectWs(
      `${wsUrl}/ws?desktopId=${desktopCredential.deviceId}`,
      bearerOf(phone),
    );
    if (!control1.ok) throw new Error('first control upgrade failed');
    await first.next();

    // 旧桌面暂停读，关闭握手将被延迟——取代后的清理不得依赖旧连接的 close 事件。
    first.socket.pause();
    const phoneClosed = new Promise<number>((resolve) => {
      control1.socket.once('close', (code: number) => resolve(code));
    });
    const second = await openDesktop(wsUrl, desktopCredential);
    expect(await phoneClosed).toBe(4010);

    // 新通道建立后，旧代次注入同一 channelId 必须被忽略。
    const phone2 = createPhoneCredential();
    const control2 = await connectWs(
      `${wsUrl}/ws?desktopId=${desktopCredential.deviceId}`,
      bearerOf(phone2),
    );
    if (!control2.ok) throw new Error('second control upgrade failed');
    const open = await second.next();
    const channelId = (open['payload'] as { channelId: string }).channelId;

    first.socket.send(
      JSON.stringify({
        type: 'channel.data',
        payload: { channelId, binary: false, data: 'FROM-OLD-GENERATION' },
      }),
    );
    const received = await new Promise<string>((resolve) => {
      let settled = false;
      control2.socket.once('message', (data) => {
        settled = true;
        resolve(data.toString());
      });
      setTimeout(() => {
        if (!settled) resolve('NONE');
      }, 300);
    });
    expect(received).toBe('NONE');
    first.socket.resume();
  });

  it('手机链路心跳：不应答 ping 超时断开（I2）', async () => {
    const { wsUrl } = await startApp({
      pingIntervalMs: 20,
      pongTimeoutMs: 60,
    });
    const desktopCredential = createDesktopCredential();
    const phone = createPhoneCredential();
    await openDesktop(wsUrl, desktopCredential);

    const phoneConnection = await connectWs(
      `${wsUrl}/ws?desktopId=${desktopCredential.deviceId}`,
      bearerOf(phone),
      { autoPong: false },
    );
    if (!phoneConnection.ok) throw new Error('phone upgrade failed');
    const code = await new Promise<number>((resolve) => {
      phoneConnection.socket.once('close', (closeCode: number) =>
        resolve(closeCode),
      );
    });
    expect(code).toBe(1006);
  });

  it('channel.close 合法码 1011 透传；手机异常断连归一为 1011（I1）', async () => {
    const { wsUrl } = await startApp();
    const desktopCredential = createDesktopCredential();
    const phone = createPhoneCredential();
    const desktop = await openDesktop(wsUrl, desktopCredential);

    const control = await connectWs(
      `${wsUrl}/ws?desktopId=${desktopCredential.deviceId}`,
      bearerOf(phone),
    );
    if (!control.ok) throw new Error('control upgrade failed');
    const open = await desktop.next();
    const channelId = (open['payload'] as { channelId: string }).channelId;

    const closed = new Promise<number>((resolve) => {
      control.socket.once('close', (code: number) => resolve(code));
    });
    desktop.socket.send(
      JSON.stringify({
        type: 'channel.close',
        payload: { channelId, code: 1011, reason: 'internal error' },
      }),
    );
    expect(await closed).toBe(1011);

    const abnormal = await connectWs(
      `${wsUrl}/ws?desktopId=${desktopCredential.deviceId}`,
      bearerOf(phone),
    );
    if (!abnormal.ok) throw new Error('abnormal upgrade failed');
    const secondOpen = await desktop.next();
    const secondChannelId = (secondOpen['payload'] as { channelId: string })
      .channelId;
    const notice = desktop.next();
    abnormal.socket.terminate();
    expect(await notice).toMatchObject({
      type: 'channel.close',
      payload: { channelId: secondChannelId, code: 1011 },
    });
  });

  it('默认上限下 12MiB 代答体经 20MiB 桌面消息上限通过（C2）', async () => {
    const { httpUrl, wsUrl } = await startApp();
    const desktopCredential = createDesktopCredential();
    const phone = createPhoneCredential();
    const desktop = await openDesktop(wsUrl, desktopCredential);

    const body = Buffer.alloc(12 * 1024 * 1024, 7);
    const pending = fetch(
      `${httpUrl}/v1/attachments?desktopId=${desktopCredential.deviceId}`,
      {
        method: 'POST',
        headers: {
          authorization: bearerOf(phone),
          'content-type': 'application/octet-stream',
        },
        body,
      },
    );
    const request = await desktop.next();
    desktop.socket.send(
      JSON.stringify({
        type: 'http.response',
        payload: {
          requestId: (request['payload'] as Record<string, string>)['requestId'],
          status: 200,
          contentType: 'application/octet-stream',
          bodyBase64: body.toString('base64'),
        },
      }),
    );
    const response = await pending;
    expect(response.status).toBe(200);
    const received = Buffer.from(await response.arrayBuffer());
    expect(received.length).toBe(body.length);
    expect(desktop.socket.readyState).toBe(WebSocket.OPEN);
  }, 30000);
});

describe('吊销联动（进程内）', () => {
  it('DELETE 桌面 → 桌面 4004、挂载手机 4010；DELETE 手机 → 4004 且令牌失效', async () => {
    const { httpUrl, wsUrl } = await startApp();
    const desktopCredential = createDesktopCredential();
    const phone = createPhoneCredential();
    const desktop = await openDesktop(wsUrl, desktopCredential);

    const control = await connectWs(
      `${wsUrl}/ws?desktopId=${desktopCredential.deviceId}`,
      bearerOf(phone),
    );
    if (!control.ok) throw new Error('control upgrade failed');
    await desktop.next();

    const controlClosed = new Promise<number>((resolve) => {
      control.socket.once('close', (code: number) => resolve(code));
    });
    const desktopClosed = new Promise<number>((resolve) => {
      desktop.socket.once('close', (code: number) => resolve(code));
    });
    const revokeDesktop = await fetch(
      `${httpUrl}/v1/devices/${desktopCredential.deviceId}`,
      { method: 'DELETE', headers: { authorization: bearerOf(phone) } },
    );
    expect(revokeDesktop.status).toBe(204);
    expect(await desktopClosed).toBe(4004);
    expect(await controlClosed).toBe(4010);

    const revokePhone = await fetch(`${httpUrl}/v1/devices/${phone.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: bearerOf(phone) },
    });
    expect(revokePhone.status).toBe(204);
    const again = await connectWs(
      `${wsUrl}/ws?desktopId=${desktopCredential.deviceId}`,
      bearerOf(phone),
    );
    expect(again).toEqual({ ok: false, status: 401 });
  });
});