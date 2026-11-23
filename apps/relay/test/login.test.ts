import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRelayApp } from '../src/app.js';
import { AuthError, authenticateBearer } from '../src/auth/authenticate.js';
import { RelayLimits } from '../src/limits.js';
import { openRelayStore } from '../src/storage/sqlite-store.js';
import { RelayStore } from '../src/storage/store.js';

let dir: string;
let store: RelayStore;
let app: FastifyInstance;

const VALID_LOGIN = {
  username: 'alice',
  password: 'pw-123456',
  clientType: 'desktop',
  deviceName: 'Mac',
  platform: 'macos',
  appVersion: '1.0.0',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-login-'));
  store = openRelayStore(dir);
  store.createAccount('alice', 'pw-123456');
});

afterEach(async () => {
  await app?.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function startApp(limits?: Partial<RelayLimits>): Promise<FastifyInstance> {
  app = await createRelayApp({ store, logger: false, limits });
  return app;
}

describe('POST /v1/auth/login', () => {
  it('desktop 登录返回设备凭证，role=desktop', async () => {
    const server = await startApp();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: VALID_LOGIN,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe('desktop');
    expect(body.deviceId).toMatch(/^dev_/);
    expect(body.contractVersion).toBe(1);
    expect(body.accountId).toMatch(/^acc_/);
    expect(store.verifyDevice(body.deviceId, body.deviceToken)).not.toBeNull();
  });

  it('用户名不存在与口令错误返回同一 401 INVALID_CREDENTIALS', async () => {
    const server = await startApp();
    const wrongPassword = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { ...VALID_LOGIN, password: 'wrong' },
    });
    const unknownUser = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { ...VALID_LOGIN, username: 'nobody' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownUser.json());
    expect(wrongPassword.json()).toEqual({
      error: { code: 'INVALID_CREDENTIALS', message: 'INVALID_CREDENTIALS' },
    });
  });

  it('禁用账号返回 403 ACCOUNT_DISABLED', async () => {
    store.setAccountDisabled('alice', true);
    const server = await startApp();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: VALID_LOGIN,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_DISABLED');
  });

  it('缺字段返回 400 INVALID_REQUEST', async () => {
    const server = await startApp();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'alice', password: 'pw-123456', clientType: 'desktop' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });

  it('非法 clientType 返回 400 INVALID_REQUEST', async () => {
    const server = await startApp();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { ...VALID_LOGIN, clientType: 'tablet' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('第 11 次登录尝试返回 429 RATE_LIMITED', async () => {
    const server = await startApp({ loginPerMinute: 10 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { ...VALID_LOGIN, password: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
    }
    const eleventh = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: VALID_LOGIN,
    });
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json().error.code).toBe('RATE_LIMITED');
  });

  it('设备数达上限返回 409 DEVICE_LIMIT_REACHED', async () => {
    const capDir = mkdtempSync(join(tmpdir(), 'relay-login-cap-'));
    const cappedStore = openRelayStore(capDir, 1);
    cappedStore.createAccount('bob', 'pw-123456');
    const cappedApp = await createRelayApp({ store: cappedStore, logger: false });
    try {
      const first = await cappedApp.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { ...VALID_LOGIN, username: 'bob' },
      });
      expect(first.statusCode).toBe(200);
      const second = await cappedApp.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { ...VALID_LOGIN, username: 'bob' },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('DEVICE_LIMIT_REACHED');
    } finally {
      await cappedApp.close();
      cappedStore.close();
      rmSync(capDir, { recursive: true, force: true });
    }
  });
});

describe('authenticateBearer', () => {
  function loginAndToken(): { deviceId: string; deviceToken: string } {
    const account = store.findAccountByUsername('alice');
    if (account === null) throw new Error('missing alice');
    const created = store.createDevice({
      accountId: account.accountId,
      role: 'phone',
      deviceName: 'iPhone',
      platform: 'ios',
      appVersion: '1.0.0',
    });
    return {
      deviceId: created.device.deviceId,
      deviceToken: created.deviceToken,
    };
  }

  it('有效 Bearer 返回设备记录', () => {
    const { deviceId, deviceToken } = loginAndToken();
    const device = authenticateBearer(store, {
      authorization: `Bearer ${deviceId}.${deviceToken}`,
    });
    expect(device.deviceId).toBe(deviceId);
  });

  it('缺失/畸形/错误令牌一律抛 UNAUTHENTICATED', () => {
    const { deviceId } = loginAndToken();
    const badHeaders: Record<string, unknown>[] = [
      {},
      { authorization: 'Basic abc' },
      { authorization: `Bearer ${deviceId}` },
      { authorization: 'Bearer %.bad' },
      { authorization: `Bearer ${deviceId}.wrong` },
      { authorization: `bearer ${deviceId}.not-at-all-valid` },
    ];
    for (const headers of badHeaders) {
      expect(() => authenticateBearer(store, headers)).toThrow(AuthError);
      expect(() => authenticateBearer(store, headers)).toThrow(
        'UNAUTHENTICATED',
      );
    }
  });
});