import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createStartRuntime } from '../../src/cli.js';
import { resolveAgentPaths } from '../../src/config/paths.js';

const NOW = 1_762_432_800_000;

function fixture(): string {
  const configDir = mkdtempSync(join(tmpdir(), 's05-cli-runtime-'));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 's05-cli-project-')));
  const paths = resolveAgentPaths(configDir);
  writeFileSync(
    paths.agentFile,
    `${JSON.stringify(
      {
        version: 3,
        desktopId: 'desktop_1',
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
  return configDir;
}

describe('CLI start runtime', () => {
  it('uses the durable runtime that mounts the ASR gateway', async () => {
    const configDir = fixture();
    const runtime = await createStartRuntime(configDir);
    try {
      // 只有 durable runtime 暴露 recovery/recoveryService/retention/health。
      expect(runtime.recoveryService).toBeDefined();
      expect(runtime.retention).toBeDefined();
      expect(runtime.health).toBeDefined();
    } finally {
      await runtime.close();
    }
  });
});