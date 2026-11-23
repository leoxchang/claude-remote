import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ManagedRunDriver,
  ManagedRunHandle,
} from '../src/adapter/managed-run-driver.js';
import { createDurableAgentRuntime } from '../src/app/runtime.js';
import { AdminClient } from '../src/admin/client.js';
import { resolveAgentPaths } from '../src/config/paths.js';
import { relayLogin } from '../src/relay/login.js';

const NOW = 1_762_432_800_000;

class NoopDriver implements ManagedRunDriver {
  startRun(): ManagedRunHandle {
    return {
      interrupt: async () => undefined,
      close: async () => undefined,
      resumeEvents: () => undefined,
    };
  }
}

function fixture(): { configDir: string; driver: NoopDriver } {
  const configDir = mkdtempSync(join(tmpdir(), 'relay-runtime-'));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'relay-runtime-ws-')));
  const paths = resolveAgentPaths(configDir);
  writeFileSync(
    paths.agentFile,
    `${JSON.stringify(
      {
        version: 3,
        desktopId: 'desktop_relay',
        workspaces: [
          {
            workspaceId: 'ws_1',
            displayName: 'Project',
            rootPath: project,
            createdAt: NOW,
            policy: { perSessionQueueLimit: 20, mobileApprovalMode: 'deny' },
          },
        ],
        listen: { host: '127.0.0.1', port: 8787 },
        tailscale: { baseUrl: 'https://mac.example-tailnet.ts.net' },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { configDir, driver: new NoopDriver() };
}

describe('durable runtime 的 relay 装配', () => {
  it('配置 relay 后启动/status/关闭均正常（relay 不可达不影响启动）', async () => {
    const { configDir, driver } = fixture();
    // 首次启动完成 v1/v3 → v5 配置迁移（真实使用顺序：init → start → relay login）。
    const bootstrap = await createDurableAgentRuntime(driver, {
      configDir,
      phoneListen: { host: '127.0.0.1', port: 0 },
    });
    await bootstrap.start();
    await bootstrap.close();

    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          accountId: 'acc_1',
          deviceId: 'dev_desktop_1',
          deviceToken: 'tok_1',
          role: 'desktop',
          contractVersion: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    await relayLogin({
      configDir,
      baseUrl: 'http://127.0.0.1:1',
      username: 'alice',
      password: 'pw-123456',
      desktopName: 'Relay Mac',
      fetchImpl: fakeFetch,
    });

    const runtime = await createDurableAgentRuntime(driver, {
      configDir,
      phoneListen: { host: '127.0.0.1', port: 0 },
    });
    try {
      await runtime.start();
      const status = await new AdminClient(
        resolveAgentPaths(configDir).socketPath,
      ).status();
      const relay = (status as { relay?: Record<string, unknown> }).relay;
      expect(relay).toMatchObject({
        enabled: true,
        baseUrl: 'http://127.0.0.1:1',
        state: 'connecting',
        lastEpoch: null,
      });
      expect(JSON.stringify(relay)).not.toContain('tok_1');
    } finally {
      await runtime.close();
    }
    rmSync(configDir, { recursive: true, force: true, maxRetries: 5 });
  }, 15000);
});