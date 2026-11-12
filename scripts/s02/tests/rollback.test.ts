import { mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { initializeConfig } from '../../../apps/agent/src/config/initialize.js';
import {
  loadConfigV2,
  migrateConfigV1ToV2,
  writeConfigV2Atomic,
} from '../../../apps/agent/src/config/config-v2.js';
import { WorkspaceManager } from '../../../apps/agent/src/workspace/workspace-manager.js';

describe('S02 rollback exercise', () => {
  it('restores the single V1 workspace without silently truncating V2', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 's02-rollback-'));
    const alpha = await mkdtemp(join(tmpdir(), 's02-rollback-a-'));
    const beta = await mkdtemp(join(tmpdir(), 's02-rollback-b-'));
    const agentFile = join(configDir, 'agent.json');
    const backupFile = join(configDir, 'agent.json.v1.bak');

    const v1 = await initializeConfig({
      configDir,
      workspacePath: alpha,
      displayName: 'Fixture Alpha',
      tailscaleBaseUrl: 'https://macbook-pro.tail0970fd.ts.net',
    });
    await writeConfigV2Atomic(configDir, migrateConfigV1ToV2(v1));
    expect((await stat(backupFile)).mode & 0o777).toBe(0o600);

    const manager = new WorkspaceManager({
      configDir,
      config: await loadConfigV2(configDir),
    });
    await manager.add({ path: beta, displayName: 'Fixture Beta' });
    expect((await loadConfigV2(configDir)).workspaces).toHaveLength(2);

    // 回滚：用 0600 备份覆盖配置，再按 V1 → V2 迁移重新加载。
    const backup = await readFile(backupFile, 'utf8');
    await writeFile(agentFile, backup, { mode: 0o600 });

    const restored = await loadConfigV2(configDir);
    expect(restored.version).toBe(2);
    expect(restored.workspaces).toHaveLength(1);
    expect(restored.workspaces[0]?.workspaceId).toBe('default');
    expect(restored.workspaces[0]?.rootPath).toBe(await realpath(alpha));
  });

  it('fails instead of inventing config when the backup is missing', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 's02-rollback-missing-'));

    await expect(loadConfigV2(configDir)).rejects.toThrow(
      'agent.json not found',
    );
  });
});