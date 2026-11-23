import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentConfigV5 } from '../../src/config/config-v5.js';
import { runDoctor } from '../../src/diagnostics/doctor.js';
import { buildRelayStatus } from '../../src/relay/status.js';

const BASE_URL = 'https://mac.example.ts.net';

let dir: string | null = null;

afterEach(() => {
  if (dir !== null) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

function writeConfig(relay?: {
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  desktopName: string;
}): void {
  dir = mkdtempSync(join(tmpdir(), 'agent-relay-status-'));
  const config: AgentConfigV5 = {
    version: 5,
    desktopId: 'desktop_test',
    database: { file: 'agent.sqlite3' },
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: BASE_URL },
    ...(relay === undefined ? {} : { relay }),
  };
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(config));
  const database = new Database(join(dir, 'agent.sqlite3'));
  database.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
  database.close();
}

describe('buildRelayStatus', () => {
  const baseConfig: AgentConfigV5 = {
    version: 5,
    desktopId: 'desktop_test',
    database: { file: 'agent.sqlite3' },
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: BASE_URL },
  };

  it('未配置 relay → enabled=false、state=null', () => {
    expect(buildRelayStatus(baseConfig, null)).toEqual({
      enabled: false,
      state: null,
      lastEpoch: null,
      lastError: null,
    });
  });

  it('配置 relay 且链路 ready → 暴露 baseUrl/state/lastEpoch，不含 deviceToken', () => {
    const configured: AgentConfigV5 = {
      ...baseConfig,
      relay: {
        baseUrl: 'http://127.0.0.1:8788',
        deviceId: 'dev_x',
        deviceToken: 'tok_secret',
        desktopName: 'Mac',
      },
    };
    const view = buildRelayStatus(configured, {
      status: 'ready',
      lastEpoch: 3,
      lastError: null,
    });
    expect(view).toEqual({
      enabled: true,
      baseUrl: 'http://127.0.0.1:8788',
      state: 'ready',
      lastEpoch: 3,
      lastError: null,
    });
    expect(JSON.stringify(view)).not.toContain('tok_secret');
  });
});

describe('doctor relay 检查项', () => {
  it('未配置 relay → pass 且提示直连模式', async () => {
    writeConfig();
    const report = await runDoctor({ configDir: dir ?? '', platform: 'linux' });
    const relayCheck = report.checks.find((entry) => entry.id === 'relay');
    if (relayCheck === undefined) throw new Error('missing relay check');
    expect(relayCheck.status).toBe('pass');
    expect(relayCheck.detail).toContain('not configured');
  });

  it('配置 relay → pass 且 detail 含 baseUrl，不含 token', async () => {
    writeConfig({
      baseUrl: 'http://127.0.0.1:8788',
      deviceId: 'dev_x',
      deviceToken: 'tok_secret',
      desktopName: 'Mac',
    });
    const report = await runDoctor({ configDir: dir ?? '', platform: 'linux' });
    const relayCheck = report.checks.find((entry) => entry.id === 'relay');
    const configCheck = report.checks.find((entry) => entry.id === 'config');
    if (relayCheck === undefined || configCheck === undefined) {
      throw new Error('missing doctor checks');
    }
    expect(relayCheck.status).toBe('pass');
    expect(relayCheck.detail).toContain('http://127.0.0.1:8788');
    expect(relayCheck.detail).not.toContain('tok_secret');
    expect(configCheck.detail).toContain('V5');
  });
});