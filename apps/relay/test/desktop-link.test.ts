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
  dir = mkdtempSync(join(tmpdir(), 'relay-desktop-'));
  store = openRelayStore(dir);
  registry = new ConnectionRegistry();
});

afterEach(async () => {
  await app?.close();
  app = null;
  // 等 WS close 事件全部落地，再关闭数据库，避免 teardown 竞态。
  await new Promise((resolve) => setTimeout(resolve, 50));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function startServer(limits: Partial<RelayLimits> = {}): Promise<string> {
  app = await createRelayApp({ store, registry, logger: false, limits });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}`;
}

function credentialFor(role: 'desktop' | 'phone'): Credential {
  const account = store.createAccount(`user-${role}`, 'pw-123456');
  const created = store.createDevice({
    accountId: account.accountId,
    role,
    deviceName: role === 'desktop' ? 'Test Mac' : 'Test iPhone',
    platform: role === 'desktop' ? 'macos' : 'ios',
    appVersion: '1.0.0',
  });
  return {
    deviceId: created.device.deviceId,
    deviceToken: created.deviceToken,
  };
}

function bearer(credential: Credential): Record<string, string> {
  return {
    authorization: `Bearer ${credential.deviceId}.${credential.deviceToken}`,
  };
}

function helloMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'desktop.hello',
    payload: {
      supportedContractVersions: [1],
      appVersion: '1.0.0',
      desktopName: 'Test Mac',
      platform: 'macos',
      handshakeId: 'hs_test',
      ...overrides,
    },
  };
}

function connect(
  baseUrl: string,
  headers: Record<string, string>,
  options: { autoPong?: boolean } = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl}/v1/desktop/ws`, {
      headers,
      ...(options.autoPong === undefined ? {} : { autoPong: options.autoPong }),
    });
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_request, response) => {
      const error = new Error(`upgrade rejected: ${response.statusCode}`);
      reject(Object.assign(error, { statusCode: response.statusCode }));
    });
    socket.once('error', reject);
  });
}

function nextMessage(
  socket: WebSocket,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), timeoutMs);
    socket.once('message', (data: RawData) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      reject(new Error('socket closed before message'));
    });
  });
}

function expectClose(
  socket: WebSocket,
  expectedCode: number,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    socket.once('close', (code: number) => {
      clearTimeout(timer);
      if (code === expectedCode) {
        resolve();
        return;
      }
      reject(new Error(`expected close ${expectedCode}, got ${code}`));
    });
  });
}

function closeCode(socket: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    socket.once('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('桌面 WSS 握手', () => {
  it('hello → ready 携带递增 epoch；再次连接 epoch+1 且旧连接收 4000', async () => {
    const baseUrl = await startServer();
    const credential = credentialFor('desktop');
    const first = await connect(baseUrl, bearer(credential));
    first.send(JSON.stringify(helloMessage()));
    const ready = await nextMessage(first);
    expect(ready['type']).toBe('desktop.ready');
    expect(ready['payload']).toMatchObject({
      contractVersion: 1,
      connectionEpoch: 1,
      handshakeId: 'hs_test',
    });

    const firstClosed = expectClose(first, 4000);
    const second = await connect(baseUrl, bearer(credential));
    second.send(JSON.stringify(helloMessage()));
    const readyAgain = await nextMessage(second);
    expect((readyAgain['payload'] as { connectionEpoch: number }).connectionEpoch).toBe(2);
    await firstClosed;
    second.close();
  });

  it('握手后 registry.isOnline 反映连接状态', async () => {
    const baseUrl = await startServer();
    const credential = credentialFor('desktop');
    expect(registry.isOnline(credential.deviceId)).toBe(false);
    const socket = await connect(baseUrl, bearer(credential));
    socket.send(JSON.stringify(helloMessage()));
    await nextMessage(socket);
    expect(registry.isOnline(credential.deviceId)).toBe(true);
    const closed = expectClose(socket, 1000);
    socket.close(1000);
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.isOnline(credential.deviceId)).toBe(false);
  });

  it('首条非 hello → close 4001', async () => {
    const baseUrl = await startServer();
    const socket = await connect(baseUrl, bearer(credentialFor('desktop')));
    const closed = expectClose(socket, 4001);
    socket.send(JSON.stringify({ type: 'channel.data', payload: {} }));
    await closed;
  });

  it('畸形 JSON → close 4001', async () => {
    const baseUrl = await startServer();
    const socket = await connect(baseUrl, bearer(credentialFor('desktop')));
    const closed = expectClose(socket, 4001);
    socket.send('not-json');
    await closed;
  });

  it('hello 超时 → close 4001', async () => {
    const baseUrl = await startServer({ handshakeTimeoutMs: 50 });
    const socket = await connect(baseUrl, bearer(credentialFor('desktop')));
    await expectClose(socket, 4001);
  });

  it('版本无交集 → error VERSION_INCOMPATIBLE + close 4002', async () => {
    const baseUrl = await startServer();
    const socket = await connect(baseUrl, bearer(credentialFor('desktop')));
    const errorMessage = nextMessage(socket);
    const closed = expectClose(socket, 4002);
    socket.send(
      JSON.stringify(helloMessage({ supportedContractVersions: [99] })),
    );
    expect(await errorMessage).toMatchObject({
      type: 'error',
      payload: { error: { code: 'VERSION_INCOMPATIBLE' } },
    });
    await closed;
  });

  it('phone 角色设备连桌面端点 → 升级失败 403', async () => {
    const baseUrl = await startServer();
    await expect(
      connect(baseUrl, bearer(credentialFor('phone'))),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('未鉴权升级 → 401', async () => {
    const baseUrl = await startServer();
    await expect(connect(baseUrl, {})).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('握手后未知消息 type → error INVALID_MESSAGE + close 4001', async () => {
    const baseUrl = await startServer();
    const socket = await connect(baseUrl, bearer(credentialFor('desktop')));
    socket.send(JSON.stringify(helloMessage()));
    await nextMessage(socket);
    const errorMessage = nextMessage(socket);
    const closed = expectClose(socket, 4001);
    socket.send(JSON.stringify({ type: 'desktop.nope', payload: {} }));
    expect(await errorMessage).toMatchObject({
      type: 'error',
      payload: { error: { code: 'INVALID_MESSAGE' } },
    });
    await closed;
  });

  it('pong 超时断开（客户端不应答 ping）', async () => {
    const baseUrl = await startServer({
      pingIntervalMs: 20,
      pongTimeoutMs: 60,
    });
    const socket = await connect(
      baseUrl,
      bearer(credentialFor('desktop')),
      { autoPong: false },
    );
    socket.send(JSON.stringify(helloMessage()));
    await nextMessage(socket);
    const code = await closeCode(socket);
    expect(code).toBe(1006);
  });
});