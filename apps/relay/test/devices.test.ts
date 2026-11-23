import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRelayApp } from '../src/app.js';
import { openRelayStore } from '../src/storage/sqlite-store.js';
import { RelayStore } from '../src/storage/store.js';

interface Credential {
  deviceId: string;
  deviceToken: string;
}

let dir: string;
let store: RelayStore;
let app: FastifyInstance;
let aliceDesk: Credential;
let alicePhone: Credential;
let bobDesk: Credential;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-devices-'));
  store = openRelayStore(dir);
  const alice = store.createAccount('alice', 'pw-123456');
  const bob = store.createAccount('bob', 'pw-123456');
  aliceDesk = createDevice(alice.accountId, 'desktop', 'Alice Mac');
  alicePhone = createDevice(alice.accountId, 'phone', 'Alice iPhone');
  bobDesk = createDevice(bob.accountId, 'desktop', 'Bob Mac');
});

afterEach(async () => {
  await app?.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function createDevice(
  accountId: string,
  role: 'phone' | 'desktop',
  deviceName: string,
): Credential {
  const created = store.createDevice({
    accountId,
    role,
    deviceName,
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

async function startApp(
  isOnline: (deviceId: string) => boolean = () => false,
): Promise<FastifyInstance> {
  app = await createRelayApp({ store, logger: false, isOnline });
  return app;
}

describe('GET /v1/desktops', () => {
  it('只列本账号 desktop 角色设备，空列表为 []', async () => {
    const server = await startApp();
    const res = await server.inject({
      method: 'GET',
      url: '/v1/desktops',
      headers: bearer(alicePhone),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.desktops).toHaveLength(1);
    expect(body.desktops[0]).toEqual({
      desktopId: aliceDesk.deviceId,
      desktopName: 'Alice Mac',
      platform: 'macos',
      appVersion: '1.0.0',
      online: false,
      lastSeenAt: null,
    });
  });

  it('isOnline 回调决定 online 字段', async () => {
    const server = await startApp(
      (deviceId) => deviceId === aliceDesk.deviceId,
    );
    const res = await server.inject({
      method: 'GET',
      url: '/v1/desktops',
      headers: bearer(alicePhone),
    });
    expect(res.json().desktops[0].online).toBe(true);
  });

  it('未鉴权返回 401 UNAUTHENTICATED', async () => {
    const server = await startApp();
    const res = await server.inject({ method: 'GET', url: '/v1/desktops' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });
});

describe('GET /v1/devices', () => {
  it('列出本账号全部设备（含角色），含 online 字段', async () => {
    const server = await startApp((deviceId) => deviceId === bobDesk.deviceId);
    const res = await server.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: bearer(alicePhone),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.devices).toHaveLength(2);
    const roles = body.devices.map((d: { role: string }) => d.role).sort();
    expect(roles).toEqual(['desktop', 'phone']);
    expect(
      body.devices.every(
        (d: { deviceToken?: string }) => d.deviceToken === undefined,
      ),
    ).toBe(true);
  });
});

describe('DELETE /v1/devices/{deviceId}', () => {
  it('删除本账号设备返回 204 且令牌立即失效', async () => {
    const server = await startApp();
    const res = await server.inject({
      method: 'DELETE',
      url: `/v1/devices/${aliceDesk.deviceId}`,
      headers: bearer(alicePhone),
    });
    expect(res.statusCode).toBe(204);
    expect(
      store.verifyDevice(aliceDesk.deviceId, aliceDesk.deviceToken),
    ).toBeNull();
  });

  it('允许删除自身设备', async () => {
    const server = await startApp();
    const res = await server.inject({
      method: 'DELETE',
      url: `/v1/devices/${alicePhone.deviceId}`,
      headers: bearer(alicePhone),
    });
    expect(res.statusCode).toBe(204);
  });

  it('删除他账号设备返回 404 DEVICE_NOT_FOUND 且不生效（Review Focus 2）', async () => {
    const server = await startApp();
    const res = await server.inject({
      method: 'DELETE',
      url: `/v1/devices/${bobDesk.deviceId}`,
      headers: bearer(alicePhone),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('DEVICE_NOT_FOUND');
    expect(
      store.verifyDevice(bobDesk.deviceId, bobDesk.deviceToken),
    ).not.toBeNull();
  });

  it('删除不存在的设备返回 404 DEVICE_NOT_FOUND', async () => {
    const server = await startApp();
    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/devices/dev_missing',
      headers: bearer(alicePhone),
    });
    expect(res.statusCode).toBe(404);
  });
});