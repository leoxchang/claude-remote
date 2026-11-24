import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AdminHttpOptions,
  adminTokenFromEnv,
} from '../src/admin/admin-http.js';
import { createRelayApp } from '../src/app.js';
import { openRelayStore } from '../src/storage/sqlite-store.js';
import { DeviceRecord, RelayStore } from '../src/storage/store.js';

const TOKEN = 'admin-token-for-tests-0123456789';

const stores: RelayStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): RelayStore {
  const dir = mkdtempSync(join(tmpdir(), 'relay-admin-http-'));
  dirs.push(dir);
  const store = openRelayStore(dir);
  stores.push(store);
  return store;
}

function makeAdmin(): AdminHttpOptions {
  return { store: makeStore(), token: TOKEN };
}

async function buildApp(admin?: AdminHttpOptions): Promise<FastifyInstance> {
  return createRelayApp({
    store: admin?.store ?? makeStore(),
    admin,
  });
}

describe('adminTokenFromEnv', () => {
  it('未设置返回 undefined', () => {
    expect(adminTokenFromEnv(undefined)).toBeUndefined();
  });

  it('长度不足 16 返回 undefined', () => {
    expect(adminTokenFromEnv('short-token')).toBeUndefined();
  });

  it('长度恰 16 原样返回', () => {
    const token = 'a'.repeat(16);
    expect(adminTokenFromEnv(token)).toBe(token);
  });
});

describe('admin api 鉴权与账号列表', () => {
  it('无 Authorization → 401 UNAUTHORIZED', async () => {
    const app = await buildApp(makeAdmin());
    const res = await app.inject({ method: 'GET', url: '/admin/api/accounts' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'UNAUTHORIZED' },
    });
  });

  it('错误令牌 → 401 UNAUTHORIZED', async () => {
    const app = await buildApp(makeAdmin());
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/accounts',
      headers: { authorization: 'Bearer wrong-token-aaaaaaaaaaaa' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'UNAUTHORIZED' },
    });
  });

  it('设备凭据不得访问 admin api', async () => {
    const admin = makeAdmin();
    const account = admin.store.createAccount('dev', 'dev-password-1');
    const created = admin.store.createDevice({
      accountId: account.accountId,
      role: 'phone',
      deviceName: 'iPhone',
      platform: 'ios',
      appVersion: '1.0.0',
    });
    const app = await buildApp(admin);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/accounts',
      headers: {
        authorization: `Bearer ${created.device.deviceId}.${created.deviceToken}`,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'UNAUTHORIZED' },
    });
  });

  it('正确令牌 → 200 {ok:true, result:[...]}', async () => {
    const admin = makeAdmin();
    admin.store.createAccount('dev', 'dev-password-1');
    const app = await buildApp(admin);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/accounts',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; result: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    expect(body.result).toHaveLength(1);
    expect(body.result[0].username).toBe('dev');
    expect(body.result[0]).not.toHaveProperty('passwordHash');
    expect(body.result[0]).not.toHaveProperty('password');
  });
});

const authHeader = { authorization: `Bearer ${TOKEN}` };

describe('admin api 写操作与断连回调', () => {
  it('create-user 返回账号记录；重复用户名 → 409', async () => {
    const admin = makeAdmin();
    const app = await buildApp(admin);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: authHeader,
      payload: { username: 'alice', password: 'pw-123456' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      result: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.result.username).toBe('alice');
    expect(body.result.disabled).toBe(false);
    expect(body.result.accountId).toBeTypeOf('string');

    const again = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: authHeader,
      payload: { username: 'alice', password: 'x' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({
      error: { code: 'USERNAME_TAKEN', message: 'USERNAME_TAKEN' },
    });
  });

  it('reset-password 成功 → 200 {ok:true}；未知用户 → 404', async () => {
    const admin = makeAdmin();
    admin.store.createAccount('alice', 'pw-123456');
    const app = await buildApp(admin);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts/alice/reset-password',
      headers: authHeader,
      payload: { password: 'pw-654321' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(admin.store.verifyPassword('alice', 'pw-654321')).not.toBeNull();

    const missing = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts/ghost/reset-password',
      headers: authHeader,
      payload: { password: 'pw-1' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: 'ACCOUNT_NOT_FOUND', message: 'ACCOUNT_NOT_FOUND' },
    });
  });

  it('disable-user 触发 onAccountDisabled(accountId)；enable-user 不触发', async () => {
    const admin = makeAdmin();
    const onAccountDisabled = vi.fn<(accountId: string) => void>();
    const account = admin.store.createAccount('alice', 'pw-123456');
    const app = await buildApp({ ...admin, onAccountDisabled });

    const disabled = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts/alice/disable',
      headers: authHeader,
    });
    expect(disabled.statusCode).toBe(200);
    expect(onAccountDisabled).toHaveBeenCalledWith(account.accountId);

    onAccountDisabled.mockClear();
    const enabled = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts/alice/enable',
      headers: authHeader,
    });
    expect(enabled.statusCode).toBe(200);
    expect(onAccountDisabled).not.toHaveBeenCalled();
  });

  it('list-devices 返回账号设备；未知用户 → 404', async () => {
    const admin = makeAdmin();
    const account = admin.store.createAccount('alice', 'pw-123456');
    admin.store.createDevice({
      accountId: account.accountId,
      role: 'desktop',
      deviceName: 'Mac',
      platform: 'macos',
      appVersion: '1.0.0',
    });
    const app = await buildApp(admin);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/accounts/alice/devices',
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; result: Array<Record<string, unknown>> };
    expect(body.result).toHaveLength(1);
    expect(body.result[0].role).toBe('desktop');

    const missing = await app.inject({
      method: 'GET',
      url: '/admin/api/accounts/ghost/devices',
      headers: authHeader,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('revoke-device 触发 onDeviceRevoked；未知设备 → 404', async () => {
    const admin = makeAdmin();
    const onDeviceRevoked = vi.fn<(device: DeviceRecord) => void>();
    const account = admin.store.createAccount('alice', 'pw-123456');
    const created = admin.store.createDevice({
      accountId: account.accountId,
      role: 'phone',
      deviceName: 'iPhone',
      platform: 'ios',
      appVersion: '1.0.0',
    });
    const app = await buildApp({ ...admin, onDeviceRevoked });

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/api/devices/${created.device.deviceId}`,
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    expect(onDeviceRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: created.device.deviceId }),
    );

    const missing = await app.inject({
      method: 'DELETE',
      url: '/admin/api/devices/dev_ghost',
      headers: authHeader,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: 'DEVICE_NOT_FOUND', message: 'DEVICE_NOT_FOUND' },
    });
  });

  it('非对象 body → 400 INVALID_REQUEST', async () => {
    const app = await buildApp(makeAdmin());
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: authHeader,
      payload: [1, 2, 3],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'INVALID_REQUEST', message: 'INVALID_REQUEST' },
    });
  });
});

describe('admin 路由 fail-closed', () => {
  it('无 admin 选项时 GET /admin 404', async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'ROUTE_NOT_FOUND', message: 'ROUTE_NOT_FOUND' },
    });
  });

  it('有 admin 选项时 GET /admin 200 text/html', async () => {
    const app = await buildApp(makeAdmin());
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Claude Remote 管理');
  });

  it('GET /admin 返回完整页面（令牌输入与账号列表）', async () => {
    const app = await buildApp(makeAdmin());
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.body).toContain('localStorage');
    expect(res.body).toContain('/admin/api');
    expect(res.body).toContain('confirm(');
  });
});

