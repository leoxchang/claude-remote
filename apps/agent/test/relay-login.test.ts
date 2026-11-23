import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readConfigV5IfExists } from '../src/config/config-v5.js';
import {
  readRelayConfig,
  relayLogin,
  removeRelayConfig,
} from '../src/relay/login.js';

const VALID_V4 = {
  version: 4,
  desktopId: 'desk_1',
  database: { file: 'agent.sqlite3' },
  listen: { host: '127.0.0.1', port: 8787 },
  tailscale: { baseUrl: 'https://mac.example.ts.net' },
};

const LOGIN_OK = {
  accountId: 'acc_1',
  deviceId: 'dev_desktop_1',
  deviceToken: 'tok_1',
  role: 'desktop',
  contractVersion: 1,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-relay-login-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeInitializedConfig(): void {
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(VALID_V4));
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('relayLogin', () => {
  it('登录成功：config v5 写入完整 relay 段且其余字段保留', async () => {
    writeInitializedConfig();
    const result = await relayLogin({
      configDir: dir,
      baseUrl: 'http://127.0.0.1:8788',
      username: 'alice',
      password: 'pw-123456',
      desktopName: 'My Mac',
      fetchImpl: fakeFetch(200, LOGIN_OK),
    });
    expect(result).toEqual({
      deviceId: 'dev_desktop_1',
      accountId: 'acc_1',
    });
    const config = readConfigV5IfExists(dir);
    expect(config?.desktopId).toBe('desk_1');
    expect(config?.relay).toEqual({
      baseUrl: 'http://127.0.0.1:8788',
      deviceId: 'dev_desktop_1',
      deviceToken: 'tok_1',
      desktopName: 'My Mac',
    });
    expect(readRelayConfig(dir)?.deviceId).toBe('dev_desktop_1');
  });

  it('401 INVALID_CREDENTIALS 抛同码错误且不写配置', async () => {
    writeInitializedConfig();
    await expect(
      relayLogin({
        configDir: dir,
        baseUrl: 'http://127.0.0.1:8788',
        username: 'alice',
        password: 'wrong',
        desktopName: 'My Mac',
        fetchImpl: fakeFetch(401, {
          error: { code: 'INVALID_CREDENTIALS', message: 'INVALID_CREDENTIALS' },
        }),
      }),
    ).rejects.toThrow('INVALID_CREDENTIALS');
    expect(readRelayConfig(dir)).toBeNull();
  });

  it('429 RATE_LIMITED 抛同码错误', async () => {
    writeInitializedConfig();
    await expect(
      relayLogin({
        configDir: dir,
        baseUrl: 'http://127.0.0.1:8788',
        username: 'alice',
        password: 'pw-123456',
        desktopName: 'My Mac',
        fetchImpl: fakeFetch(429, {
          error: { code: 'RATE_LIMITED', message: 'RATE_LIMITED' },
        }),
      }),
    ).rejects.toThrow('RATE_LIMITED');
  });

  it('响应体畸形抛 INVALID_RESPONSE', async () => {
    writeInitializedConfig();
    await expect(
      relayLogin({
        configDir: dir,
        baseUrl: 'http://127.0.0.1:8788',
        username: 'alice',
        password: 'pw-123456',
        desktopName: 'My Mac',
        fetchImpl: fakeFetch(200, { deviceId: 42 }),
      }),
    ).rejects.toThrow('INVALID_RESPONSE');
  });

  it('非 JSON 错误体退回 HTTP 状态码', async () => {
    writeInitializedConfig();
    const textFetch = (async () =>
      new Response('boom', { status: 500 })) as typeof fetch;
    await expect(
      relayLogin({
        configDir: dir,
        baseUrl: 'http://127.0.0.1:8788',
        username: 'alice',
        password: 'pw-123456',
        desktopName: 'My Mac',
        fetchImpl: textFetch,
      }),
    ).rejects.toThrow('500');
  });

  it('错误体 code 非字符串时退回 HTTP 状态码', async () => {
    writeInitializedConfig();
    await expect(
      relayLogin({
        configDir: dir,
        baseUrl: 'http://127.0.0.1:8788',
        username: 'alice',
        password: 'pw-123456',
        desktopName: 'My Mac',
        fetchImpl: fakeFetch(429, { error: { code: 42 } }),
      }),
    ).rejects.toThrow('429');
  });

  it('登录响应 deviceToken 为空 → INVALID_RESPONSE 且不写配置', async () => {
    writeInitializedConfig();
    await expect(
      relayLogin({
        configDir: dir,
        baseUrl: 'http://127.0.0.1:8788',
        username: 'alice',
        password: 'pw-123456',
        desktopName: 'My Mac',
        fetchImpl: fakeFetch(200, { ...LOGIN_OK, deviceToken: '' }),
      }),
    ).rejects.toThrow('INVALID_RESPONSE');
    expect(readRelayConfig(dir)).toBeNull();
  });

  it('未 init 的 configDir 抛 AGENT_NOT_INITIALIZED', async () => {
    await expect(
      relayLogin({
        configDir: dir,
        baseUrl: 'http://127.0.0.1:8788',
        username: 'alice',
        password: 'pw-123456',
        desktopName: 'My Mac',
        fetchImpl: fakeFetch(200, LOGIN_OK),
      }),
    ).rejects.toThrow('AGENT_NOT_INITIALIZED');
  });
});

describe('removeRelayConfig', () => {
  it('移除 relay 段且幂等；其余字段保留', async () => {
    writeInitializedConfig();
    await relayLogin({
      configDir: dir,
      baseUrl: 'http://127.0.0.1:8788',
      username: 'alice',
      password: 'pw-123456',
      desktopName: 'My Mac',
      fetchImpl: fakeFetch(200, LOGIN_OK),
    });
    removeRelayConfig(dir);
    expect(readRelayConfig(dir)).toBeNull();
    expect(readConfigV5IfExists(dir)?.desktopId).toBe('desk_1');
    expect(() => removeRelayConfig(dir)).not.toThrow();
    const raw = readFileSync(join(dir, 'agent.json'), 'utf8');
    expect(raw).not.toContain('tok_1');
  });
});