import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AgentConfigV3,
  loadConfigV3,
  migrateConfigV2ToV3,
  writeConfigV3AtomicSync,
} from '../../../apps/agent/src/config/config-v3.js';
import { WorkspaceManager } from '../../../apps/agent/src/workspace/workspace-manager.js';
import { WorkspaceRecord } from '../../../apps/agent/src/workspace/workspace-types.js';

const FIXED_NOW = 1_762_432_800_000;

function v3Config(workspaces: WorkspaceRecord[]): AgentConfigV3 {
  return {
    version: 3,
    desktopId: 'desktop_rollback',
    workspaces,
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: 'https://macbook-pro.tail0970fd.ts.net' },
  };
}

function workspace(id: string): WorkspaceRecord {
  return {
    workspaceId: id,
    displayName: `Fixture ${id}`,
    rootPath: `/tmp/${id}`,
    createdAt: FIXED_NOW,
    policy: { perSessionQueueLimit: 20, mobileApprovalMode: 'allow_once' },
  };
}

describe('S03 rollback exercise', () => {
  it('sets every workspace to deny before restoring the V2 backup', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 's03-rollback-'));
    const config = v3Config([workspace('ws_a'), workspace('ws_b')]);
    writeConfigV3AtomicSync(configDir, config);
    const manager = new WorkspaceManager({
      configDir,
      config: await loadConfigV3(configDir),
      writeConfig: ((_dir, next: AgentConfigV3) => {
        writeConfigV3AtomicSync(configDir, next);
      }),
    });

    manager.setApprovalMode('ws_a', 'deny');
    manager.setApprovalMode('ws_b', 'deny');
    expect(manager.approvalMode('ws_a')).toBe('deny');
    expect(manager.approvalMode('ws_b')).toBe('deny');

    const v2Backup = JSON.stringify({
      version: 2,
      desktopId: 'desktop_rollback',
      workspaces: [
        {
          workspaceId: 'ws_a',
          displayName: 'Fixture ws_a',
          rootPath: '/tmp/ws_a',
          createdAt: FIXED_NOW,
          policy: { perSessionQueueLimit: 20 },
        },
      ],
      listen: { host: '127.0.0.1', port: 8787 },
      tailscale: { baseUrl: 'https://macbook-pro.tail0970fd.ts.net' },
    });
    const backupPath = join(configDir, 'agent.json.v2.bak');
    await writeFile(backupPath, v2Backup, { mode: 0o600 });
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);

    // 回滚：用 V2 备份覆盖配置，再按 V2 → V3 迁移加载。
    await writeFile(join(configDir, 'agent.json'), v2Backup, { mode: 0o600 });
    const restored = await loadConfigV3(configDir);

    expect(restored.version).toBe(3);
    expect(restored.workspaces).toHaveLength(1);
    expect(restored.workspaces[0]?.policy.mobileApprovalMode).toBe('deny');
    expect(await readFile(backupPath, 'utf8')).toBe(v2Backup);
  });

  it('never silently enables approval when migrating an unknown mode', async () => {
    const config = {
      version: 2,
      desktopId: 'desktop_rollback',
      workspaces: [
        {
          workspaceId: 'ws_a',
          displayName: 'Fixture ws_a',
          rootPath: '/tmp/ws_a',
          createdAt: FIXED_NOW,
          policy: { perSessionQueueLimit: 20, mobileApprovalMode: 'allow_once' },
        },
      ],
      listen: { host: '127.0.0.1', port: 8787 },
      tailscale: { baseUrl: 'https://macbook-pro.tail0970fd.ts.net' },
    };

    expect(
      migrateConfigV2ToV3(config).workspaces[0]?.policy.mobileApprovalMode,
    ).toBe('deny');
  });
});