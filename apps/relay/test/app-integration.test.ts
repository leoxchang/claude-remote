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
): Promise<
  { ok: true; socket: WebSocket } | { ok: false; status: number }
> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, {
      ...(authHeader === undefined
        ? {}
        : { headers: { authorization: authHeader } }),
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