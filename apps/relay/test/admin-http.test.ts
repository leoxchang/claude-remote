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

