import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockManagedRunDriver } from '../src/adapter/mock-managed-run-driver.js';
import { createAgentRuntime } from '../src/app/runtime.js';
import { AgentLogger } from '../src/app/logger.js';
import { AgentConfig } from '../src/domain/types.js';
import {
  loadConfigV3,
  migrateConfigV2ToV3,
  parseAgentConfigV3,
  writeConfigV3AtomicSync,
} from '../src/config/config-v3.js';

const TAILSCALE_URL = 'https://macbook-pro.tail0970fd.ts.net';

const V1_CONFIG: AgentConfig = {
  version: 1,
  desktopId: 'desktop_01',
  workspace: {
    workspaceId: 'default',
    displayName: 'Fixture Alpha',
    rootPath: '/tmp/fixture-alpha',
  },
  listen: { host: '127.0.0.1', port: 8787 },
  tailscale: { baseUrl: TAILSCALE_URL },
};

function workspace(
  index: number,
  policy: Record<string, unknown> = { perSessionQueueLimit: 20 },
): Record<string, unknown> {
  return {
    workspaceId: `ws_${index}`,
    displayName: `Workspace ${index}`,
    rootPath: `/tmp/fixture-${index}`,
    createdAt: 1_762_432_800_000 + index,
    policy,
  };
}

function v2Config(workspaces: unknown[]): Record<string, unknown> {
  return {
    version: 2,
    desktopId: 'desktop_01',
    workspaces,
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: TAILSCALE_URL },
  };
}

function v3Config(workspaces: unknown[]): Record<string, unknown> {
  return { ...v2Config(workspaces), version: 3 };
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'claude-remote-config-v3-'));
});

afterEach(async () => {
  await chmod(configDir, 0o700).catch(() => undefined);
  await rm(configDir, { recursive: true, force: true });
});

describe('migrateConfigV2ToV3', () => {
  it('adds deny to every workspace and preserves ids and queue limits', () => {
    const migrated = migrateConfigV2ToV3(
      v2Config([
        workspace(1, { perSessionQueueLimit: 5 }),
        workspace(2, { perSessionQueueLimit: 20 }),
      ]),
    );

    expect(migrated.version).toBe(3);
    expect(migrated.desktopId).toBe('desktop_01');
    expect(
      migrated.workspaces.map((entry) => entry.policy.mobileApprovalMode),
    ).toEqual(['deny', 'deny']);
    expect(
      migrated.workspaces.map((entry) => entry.policy.perSessionQueueLimit),
    ).toEqual([5, 20]);
    expect(migrated.workspaces.map((entry) => entry.workspaceId)).toEqual([
      'ws_1',
      'ws_2',
    ]);
    expect(migrated.workspaces[0]?.createdAt).toBe(1_762_432_800_001);
    expect(migrated.tailscale.baseUrl).toBe(TAILSCALE_URL);
  });

  it('migrates a V1 config through V2 with a deny policy', () => {
    const migrated = migrateConfigV2ToV3(V1_CONFIG);

    expect(migrated.version).toBe(3);
    expect(migrated.workspaces).toHaveLength(1);
    expect(migrated.workspaces[0]?.workspaceId).toBe('default');
    expect(migrated.workspaces[0]?.policy.mobileApprovalMode).toBe('deny');
  });

  it('accepts an already migrated V3 config', () => {
    const config = v3Config([
      workspace(1, {
        perSessionQueueLimit: 20,
        mobileApprovalMode: 'allow_once',
      }),
    ]);

    expect(migrateConfigV2ToV3(config).workspaces[0]?.policy.mobileApprovalMode).toBe(
      'allow_once',
    );
  });

  it('forces deny when a V2 file already carries a mode', () => {
    const config = v2Config([
      workspace(1, {
        perSessionQueueLimit: 20,
        mobileApprovalMode: 'allow_once',
      }),
    ]);

    expect(migrateConfigV2ToV3(config).workspaces[0]?.policy.mobileApprovalMode).toBe(
      'deny',
    );
  });
});

describe('parseAgentConfigV3', () => {
  it('rejects unknown or missing approval modes', () => {
    for (const policy of [
      { perSessionQueueLimit: 20 },
      { perSessionQueueLimit: 20, mobileApprovalMode: 'always' },
      { perSessionQueueLimit: 20, mobileApprovalMode: null },
    ]) {
      expect(() => parseAgentConfigV3(v3Config([workspace(1, policy)]))).toThrow(
        'INVALID_CONFIG',
      );
    }
  });

  it('rejects non-V3 documents and invalid queue limits', () => {
    expect(() =>
      parseAgentConfigV3(v2Config([workspace(1)])),
    ).toThrow('INVALID_CONFIG');
    expect(() =>
      parseAgentConfigV3(
        v3Config([workspace(1, { perSessionQueueLimit: 0, mobileApprovalMode: 'deny' })]),
      ),
    ).toThrow('INVALID_CONFIG');
  });
});

describe('writeConfigV3AtomicSync', () => {
  it('keeps a 0600 V2 backup before replacing the file', async () => {
    const agentFile = join(configDir, 'agent.json');
    const original = `${JSON.stringify(v2Config([workspace(1)]), null, 2)}\n`;
    await writeFile(agentFile, original, { mode: 0o600 });

    writeConfigV3AtomicSync(configDir, migrateConfigV2ToV3(JSON.parse(original)));

    const backup = await readFile(join(configDir, 'agent.json.v2.bak'), 'utf8');
    expect(backup).toBe(original);
    expect((await stat(join(configDir, 'agent.json.v2.bak'))).mode & 0o777).toBe(
      0o600,
    );
    const written = JSON.parse(await readFile(agentFile, 'utf8')) as {
      version: number;
    };
    expect(written.version).toBe(3);
    expect((await stat(agentFile)).mode & 0o777).toBe(0o600);
  });

  it('does not overwrite an existing V2 backup', async () => {
    const agentFile = join(configDir, 'agent.json');
    await writeFile(agentFile, `${JSON.stringify(v2Config([workspace(1)]))}\n`, {
      mode: 0o600,
    });
    await writeFile(join(configDir, 'agent.json.v2.bak'), 'first-backup', {
      mode: 0o600,
    });

    writeConfigV3AtomicSync(configDir, migrateConfigV2ToV3(v2Config([workspace(1)])));

    expect(await readFile(join(configDir, 'agent.json.v2.bak'), 'utf8')).toBe(
      'first-backup',
    );
  });

  it('does not replace the file when the directory is read-only', async () => {
    const agentFile = join(configDir, 'agent.json');
    const original = `${JSON.stringify(v2Config([workspace(1)]))}\n`;
    await writeFile(agentFile, original, { mode: 0o600 });
    await chmod(configDir, 0o500);

    expect(() =>
      writeConfigV3AtomicSync(configDir, migrateConfigV2ToV3(v2Config([workspace(1)]))),
    ).toThrow();

    await chmod(configDir, 0o700);
    expect(await readFile(agentFile, 'utf8')).toBe(original);
  });
});

describe('loadConfigV3', () => {
  it('migrates a V2 file in memory without writing it', async () => {
    const agentFile = join(configDir, 'agent.json');
    const original = `${JSON.stringify(v2Config([workspace(1)]), null, 2)}\n`;
    await writeFile(agentFile, original, { mode: 0o600 });

    const loaded = await loadConfigV3(configDir);

    expect(loaded.version).toBe(3);
    expect(loaded.workspaces[0]?.policy.mobileApprovalMode).toBe('deny');
    expect(await readFile(agentFile, 'utf8')).toBe(original);
  });

  it('fails when agent.json is missing', async () => {
    await expect(loadConfigV3(configDir)).rejects.toThrow('agent.json not found');
  });
});

describe('startup migration', () => {
  const silentLogger: AgentLogger = {
    info: () => undefined,
    warn: () => undefined,
  };

  it('writes V3 with deny and keeps both backups when starting from V1', async () => {
    const agentFile = join(configDir, 'agent.json');
    await writeFile(agentFile, `${JSON.stringify(V1_CONFIG, null, 2)}\n`, {
      mode: 0o600,
    });

    const runtime = await createAgentRuntime(V1_CONFIG, new MockManagedRunDriver(), {
      configDir,
      logger: silentLogger,
    });
    await runtime.close();

    const written = JSON.parse(await readFile(agentFile, 'utf8')) as {
      version: number;
      workspaces: Array<{ policy: { mobileApprovalMode: string } }>;
    };
    expect(written.version).toBe(3);
    expect(written.workspaces[0]?.policy.mobileApprovalMode).toBe('deny');
    expect((await stat(join(configDir, 'agent.json.v1.bak'))).isFile()).toBe(
      true,
    );
    const v2Backup = JSON.parse(
      await readFile(join(configDir, 'agent.json.v2.bak'), 'utf8'),
    ) as { version: number };
    expect(v2Backup.version).toBe(2);
  });

  it('upgrades an existing V2 file without touching its queue limits', async () => {
    const agentFile = join(configDir, 'agent.json');
    await writeFile(
      agentFile,
      `${JSON.stringify(v2Config([workspace(1, { perSessionQueueLimit: 7 })]), null, 2)}\n`,
      { mode: 0o600 },
    );

    const runtime = await createAgentRuntime(
      V1_CONFIG,
      new MockManagedRunDriver(),
      { configDir, logger: silentLogger },
    );
    await runtime.close();

    const written = JSON.parse(await readFile(agentFile, 'utf8')) as {
      version: number;
      workspaces: Array<{
        policy: { perSessionQueueLimit: number; mobileApprovalMode: string };
      }>;
    };
    expect(written.version).toBe(3);
    expect(written.workspaces[0]?.policy.perSessionQueueLimit).toBe(7);
    expect(written.workspaces[0]?.policy.mobileApprovalMode).toBe('deny');
  });
});