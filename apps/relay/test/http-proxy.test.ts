import { mkdtempSync, rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRelayApp } from '../src/app.js';
import { HttpTunnel, TunnelError } from '../src/tunnel/http-proxy.js';
import { DesktopLink } from '../src/routing/registry.js';
import { openRelayStore } from '../src/storage/sqlite-store.js';
import { RelayStore } from '../src/storage/store.js';

interface SentMessage {
  type: string;
  payload: Record<string, unknown>;
}

function fakeDesktop(
  desktopId = 'dev_desktop',
): { link: DesktopLink; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const link: DesktopLink = {
    desktopId,
    accountId: 'acc_1',
    epoch: 1,
    socket: { readyState: 1, send: () => {} } as unknown as WebSocket,
    channels: new Map(),
    send: (message) => {
      sent.push(message as unknown as SentMessage);
    },
  };
  return { link, sent };
}

function errorCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'RESOLVED',
    (error: unknown) => (error instanceof TunnelError ? error.code : 'OTHER'),
  );
}

describe('HttpTunnel', () => {
  it('超时 reject GATEWAY_TIMEOUT；迟到 http.response 不抛错', async () => {
    const tunnel = new HttpTunnel({ httpTimeoutMs: 50, httpBodyBytes: 1024 });
    const { link, sent } = fakeDesktop();
    const failure = errorCode(
      tunnel.request(link, {
        deviceId: 'dev_phone',
        method: 'POST',
        path: '/v1/attachments',
        body: Buffer.from('{}'),
      }),
    );
    expect(await failure).toBe('GATEWAY_TIMEOUT');

    const requestId = sent[0]?.payload['requestId'] as string;
    expect(requestId).toMatch(/^req_/);
    expect(
      tunnel.handleResponse({
        requestId,
        status: 200,
        bodyBase64: Buffer.from('late').toString('base64'),
      }),
    ).toBe(true);
  });

  it('未知 requestId 的响应被丢弃且返回已处理', () => {
    const tunnel = new HttpTunnel({ httpTimeoutMs: 1000, httpBodyBytes: 1024 });
    expect(
      tunnel.handleResponse({ requestId: 'req_unknown', status: 200 }),
    ).toBe(true);
    expect(tunnel.handleResponse({ bogus: true })).toBe(false);
  });

  it('桌面断开只 reject 该桌面的 pending（DESKTOP_OFFLINE）', async () => {
    const tunnel = new HttpTunnel({ httpTimeoutMs: 5000, httpBodyBytes: 1024 });
    const first = fakeDesktop('dev_a');
    const second = fakeDesktop('dev_b');
    const firstFailure = errorCode(
      tunnel.request(first.link, {
        deviceId: 'dev_p1',
        method: 'GET',
        path: '/v1/runs/r1/prompt',
      }),
    );
    const secondRequest = tunnel.request(second.link, {
      deviceId: 'dev_p2',
      method: 'GET',
      path: '/v1/runs/r2/prompt',
    });

    tunnel.failDesktop('dev_a');
    expect(await firstFailure).toBe('DESKTOP_OFFLINE');

    const secondId = second.sent[0]?.payload['requestId'] as string;
    tunnel.handleResponse({
      requestId: secondId,
      status: 200,
      contentType: 'text/plain',
      bodyBase64: Buffer.from('ok').toString('base64'),
    });
    const response = await secondRequest;
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('ok');
  });

  it('响应体超 httpBodyBytes → GATEWAY_ERROR', async () => {
    const tunnel = new HttpTunnel({ httpTimeoutMs: 5000, httpBodyBytes: 100 });
    const { link, sent } = fakeDesktop();
    const failure = errorCode(
      tunnel.request(link, {
        deviceId: 'dev_p',
        method: 'GET',
        path: '/v1/runs/r1/prompt',
      }),
    );
    const requestId = sent[0]?.payload['requestId'] as string;
    tunnel.handleResponse({
      requestId,
      status: 200,
      bodyBase64: Buffer.alloc(101).toString('base64'),
    });
    expect(await failure).toBe('GATEWAY_ERROR');
  });
});

describe('桌面入站消息大小上限', () => {
  let dir: string;
  let store: RelayStore;
  let app: FastifyInstance | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-proxy-'));
    store = openRelayStore(dir);
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('入站单条消息超 desktopMessageBytes(1KiB) → close 4003', async () => {
    app = await createRelayApp({
      store,
      logger: false,
      limits: { desktopMessageBytes: 1024 },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const account = store.createAccount('alice', 'pw-123456');
    const created = store.createDevice({
      accountId: account.accountId,
      role: 'desktop',
      deviceName: 'Mac',
      platform: 'macos',
      appVersion: '1.0.0',
    });
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/desktop/ws`, {
      headers: {
        authorization: `Bearer ${created.device.deviceId}.${created.deviceToken}`,
      },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.send(
      JSON.stringify({
        type: 'desktop.hello',
        payload: {
          supportedContractVersions: [1],
          appVersion: '1.0.0',
          desktopName: 'Mac',
          platform: 'macos',
          handshakeId: 'hs_1',
        },
      }),
    );
    await new Promise<void>((resolve) => {
      socket.once('message', () => resolve());
    });

    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code: number) => resolve(code));
    });
    socket.send(JSON.stringify({ type: 'x', pad: 'a'.repeat(1500) }));
    expect(await closed).toBe(4003);
  });
});