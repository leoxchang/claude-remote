import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentConfigV4 } from '../src/config/config-v4.js';
import {
  AgentConfigV5,
  migrateV4ToV5,
  parseAgentConfigV5,
  readConfigV5IfExists,
  writeConfigV5AtomicSync,
} from '../src/config/config-v5.js';

const VALID_V4: AgentConfigV4 = {
  version: 4,
  desktopId: 'desk_1',
  database: { file: 'agent.sqlite3' },
  listen: { host: '127.0.0.1', port: 8787 },
  tailscale: { baseUrl: 'https://mac.example.ts.net' },
};

const RELAY = {
  baseUrl: 'http://127.0.0.1:8788',
  deviceId: 'dev_abc',
  deviceToken: 'token_xyz',
  desktopName: 'MacBook Pro',
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-config-v5-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migrateV4ToV5', () => {
  it('v4 迁移为 v5：字段保留、relay 缺省', () => {
    const config = migrateV4ToV5(VALID_V4);
    expect(config).toEqual({
      version: 5,
      desktopId: 'desk_1',
      database: { file: 'agent.sqlite3' },
      listen: { host: '127.0.0.1', port: 8787 },
      tailscale: { baseUrl: 'https://mac.example.ts.net' },
    });
    expect('relay' in config).toBe(false);
  });
});

describe('write/read 往返', () => {
  it('带 relay 段原样保留且文件权限 0600', () => {
    const config: AgentConfigV5 = { ...migrateV4ToV5(VALID_V4), relay: RELAY };
    writeConfigV5AtomicSync(dir, config);
    expect(readConfigV5IfExists(dir)).toEqual(config);
  });

  it('v4 文件在无 v5 时经 readConfigV5IfExists 返回 null（交由迁移）', () => {
    writeFileSync(join(dir, 'agent.json'), JSON.stringify(VALID_V4));
    expect(readConfigV5IfExists(dir)).toBeNull();
  });
});

describe('parseAgentConfigV5 校验', () => {
  const validV5: AgentConfigV5 = { ...migrateV4ToV5(VALID_V4), relay: RELAY };

  it('relay 合法时通过', () => {
    expect(parseAgentConfigV5(validV5)).toEqual(validV5);
  });

  it('relay 缺 deviceToken / desktopName 空 → INVALID_CONFIG', () => {
    const noToken = {
      ...validV5,
      relay: { baseUrl: RELAY.baseUrl, deviceId: 'dev_a', desktopName: 'Mac' },
    };
    expect(() => parseAgentConfigV5(noToken)).toThrow('INVALID_CONFIG');
    const emptyName = {
      ...validV5,
      relay: { ...RELAY, desktopName: '' },
    };
    expect(() => parseAgentConfigV5(emptyName)).toThrow('INVALID_CONFIG');
  });

  it('relay.baseUrl 非 http(s) → INVALID_CONFIG', () => {
    for (const baseUrl of ['ftp://x', 'not a url', '']) {
      expect(() =>
        parseAgentConfigV5({ ...validV5, relay: { ...RELAY, baseUrl } }),
      ).toThrow('INVALID_CONFIG');
    }
  });

  it('relay 非对象 → INVALID_CONFIG', () => {
    expect(() => parseAgentConfigV5({ ...validV5, relay: 'yes' })).toThrow(
      'INVALID_CONFIG',
    );
  });

  it('v4 结构（缺 version 5）→ INVALID_CONFIG', () => {
    expect(() => parseAgentConfigV5(VALID_V4)).toThrow('INVALID_CONFIG');
  });
});