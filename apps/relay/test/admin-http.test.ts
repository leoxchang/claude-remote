import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AdminHttpOptions,
  adminTokenFromEnv,
} from '../src/admin/admin-http.js';
import { createRelayApp } from '../src/app.js';
import { openRelayStore } from '../src/storage/sqlite-store.js';
import { RelayStore } from '../src/storage/store.js';

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
});

