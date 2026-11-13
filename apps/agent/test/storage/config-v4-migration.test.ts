import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentDatabase } from '../../src/storage/database.js';
import {
  migrateV3Sources,
  sha256Text,
} from '../../src/storage/config-v4-migration.js';
import { resolveAgentPaths } from '../../src/config/paths.js';
import { readConfigV4IfExists } from '../../src/config/config-v4.js';

const NOW = 1_762_432_800_000;

const DEVICES = {
  version: 1,
  devices: [
    {
      deviceId: 'device_1',
      deviceName: 'iPhone',
      tokenHash: 'hash_device_1',
      createdAt: '2026-11-01T00:00:00.000Z',
      revokedAt: null,
    },
    {
      deviceId: 'device_old',
      deviceName: 'Old iPhone',
      tokenHash: 'hash_device_old',
      createdAt: '2026-10-01T00:00:00.000Z',
      revokedAt: '2026-10-02T00:00:00.000Z',
    },
  ],
};

function v3(version = 3): Record<string, unknown> {
  return {
    version,
    desktopId: 'desktop_1',
    workspaces: [
      {
        workspaceId: 'ws_a',
        displayName: 'Alpha',
        rootPath: '/tmp/alpha',
        createdAt: NOW,
        policy:
          version === 3
            ? { perSessionQueueLimit: 20, mobileApprovalMode: 'allow_once' }
            : { perSessionQueueLimit: 5 },
      },
      {
        workspaceId: 'ws_b',
        displayName: 'Beta',
        rootPath: '/tmp/beta',
        createdAt: NOW,
        policy:
          version === 3
            ? { perSessionQueueLimit: 3, mobileApprovalMode: 'deny' }
            : { perSessionQueueLimit: 5 },
      },
    ],
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: 'https://mac.example-tailnet.ts.net' },
  };
}

function fixture(config: Record<string, unknown> = v3()) {
  const configDir = mkdtempSync(join(tmpdir(), 's04-migrate-'));
  const paths = resolveAgentPaths(configDir);
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(paths.agentFile, configText, { mode: 0o600 });
  const devicesText = `${JSON.stringify(DEVICES, null, 2)}\n`;
  writeFileSync(paths.devicesFile, devicesText, { mode: 0o600 });
  chmodSync(paths.devicesFile, 0o600);
  const db = AgentDatabase.open(join(configDir, 'agent.sqlite3'));
  return {
    configDir,
    paths,
    db,
    configText,
    devicesText,
    hashes: {
      config: sha256Text(configText),
      devices: sha256Text(devicesText),
    },
  };
}

function run(
  context: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof migrateV3Sources>[0]> = {},
) {
  return migrateV3Sources({
    configDir: context.configDir,
    uow: context.db.uow,
    sourceHashes: context.hashes,
    now: NOW,
    ...overrides,
  });
}

describe('V3 to V4 two-phase migration', () => {
  it('imports IDs, roots, policy and token hashes then writes bootstrap V4', () => {
    const context = fixture();
    try {
      const result = run(context);

      expect(result).toMatchObject({
        state: 'completed',
        imported: true,
        counts: { workspaces: 2, devices: 2 },
      });
      const workspaces = context.db.connection
        .prepare(
          'SELECT workspaceId, rootPath, perSessionQueueLimit, mobileApprovalMode FROM workspaces ORDER BY workspaceId',
        )
        .all();
      expect(workspaces).toEqual([
        {
          workspaceId: 'ws_a',
          rootPath: '/tmp/alpha',
          perSessionQueueLimit: 20,
          mobileApprovalMode: 'allow_once',
        },
        {
          workspaceId: 'ws_b',
          rootPath: '/tmp/beta',
          perSessionQueueLimit: 3,
          mobileApprovalMode: 'deny',
        },
      ]);
      const devices = context.db.connection
        .prepare('SELECT deviceId, tokenHash, revokedAt FROM devices ORDER BY deviceId')
        .all() as { deviceId: string; tokenHash: string; revokedAt: number | null }[];
      expect(devices.map((row) => row.deviceId)).toEqual(['device_1', 'device_old']);
      expect(devices[0]?.tokenHash).toBe('hash_device_1');
      expect(devices[1]?.revokedAt).not.toBeNull();

      const v4 = readConfigV4IfExists(context.configDir);
      expect(v4).not.toBeNull();
      expect(v4?.desktopId).toBe('desktop_1');
      expect(v4).not.toHaveProperty('workspaces');
      expect(statSync(context.paths.agentFile).mode & 0o777).toBe(0o600);
      expect(
        statSync(`${context.paths.agentFile}.v3.pre-sqlite.bak`).mode & 0o777,
      ).toBe(0o600);
      expect(
        statSync(`${context.paths.devicesFile}.pre-sqlite.bak`).mode & 0o777,
      ).toBe(0o600);

      const sources = context.db.connection
        .prepare('SELECT sourceType, sourceHash FROM migration_sources ORDER BY sourceType')
        .all() as { sourceType: string; sourceHash: string }[];
      expect(sources).toEqual([
        { sourceType: 'agent_config', sourceHash: context.hashes.config },
        { sourceType: 'devices', sourceHash: context.hashes.devices },
      ]);
      expect(
        context.db.connection
          .prepare('SELECT migrationState FROM schema_meta WHERE id = 1')
          .get(),
      ).toEqual({ migrationState: 'completed' });
    } finally {
      context.db.close();
    }
  });

  it('resumes after a crash between DB commit and V4 write without reimporting', () => {
    const context = fixture();
    try {
      expect(() =>
        run(context, {
          hooks: {
            afterDatabaseCommit: () => {
              throw new Error('crash');
            },
          },
        }),
      ).toThrow('crash');
      expect(
        context.db.connection
          .prepare('SELECT migrationState FROM schema_meta WHERE id = 1')
          .get(),
      ).toEqual({ migrationState: 'database_committed' });
      expect(readConfigV4IfExists(context.configDir)).toBeNull();

      const resumed = run(context);
      expect(resumed).toMatchObject({
        state: 'completed',
        imported: false,
        counts: { workspaces: 2, devices: 2 },
      });
      expect(readConfigV4IfExists(context.configDir)?.desktopId).toBe('desktop_1');
    } finally {
      context.db.close();
    }
  });

  it('completes the second phase after a crash between V4 write and completion', () => {
    const context = fixture();
    try {
      expect(() =>
        run(context, {
          hooks: {
            afterV4Write: () => {
              throw new Error('crash');
            },
          },
        }),
      ).toThrow('crash');
      expect(readConfigV4IfExists(context.configDir)).not.toBeNull();

      const resumed = run(context);
      expect(resumed.imported).toBe(false);
      expect(resumed.state).toBe('completed');
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM workspaces')
          .get(),
      ).toEqual({ total: 2 });
    } finally {
      context.db.close();
    }
  });

  it('fails closed on a source hash mismatch', () => {
    const context = fixture();
    try {
      expect(() =>
        run(context, {
          sourceHashes: { ...context.hashes, config: 'wrong' },
        }),
      ).toThrow(/STORAGE_MIGRATION_CONFLICT/);
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM workspaces')
          .get(),
      ).toEqual({ total: 0 });
    } finally {
      context.db.close();
    }
  });

  it('fails closed when V4 exists but the database was never migrated', () => {
    const context = fixture();
    try {
      const v4 = {
        version: 4,
        desktopId: 'desktop_1',
        database: { file: 'agent.sqlite3' },
        listen: { host: '127.0.0.1', port: 8787 },
        tailscale: { baseUrl: 'https://mac.example-tailnet.ts.net' },
      };
      writeFileSync(context.paths.agentFile, JSON.stringify(v4), { mode: 0o600 });
      expect(() => run(context)).toThrow(/STORAGE_MIGRATION_CONFLICT/);
    } finally {
      context.db.close();
    }
  });

  it('marks a V2 configuration as deny and completes without devices', () => {
    const context = fixture(v3(2));
    try {
      rmSync(context.paths.devicesFile);
      const result = run(context, {
        sourceHashes: {
          config: sha256Text(readFileSync(context.paths.agentFile, 'utf8')),
          devices: null,
        },
      });
      expect(result).toMatchObject({
        state: 'completed',
        imported: true,
        counts: { workspaces: 2, devices: 0 },
      });
      const modes = context.db.connection
        .prepare('SELECT mobileApprovalMode FROM workspaces ORDER BY workspaceId')
        .all() as { mobileApprovalMode: string }[];
      expect(modes.map((row) => row.mobileApprovalMode)).toEqual(['deny', 'deny']);
    } finally {
      context.db.close();
    }
  });

  it('keeps reruns idempotent once completed', () => {
    const context = fixture();
    try {
      run(context);
      const again = run(context);
      expect(again).toMatchObject({ state: 'completed', imported: false });
      expect(existsSync(`${context.paths.agentFile}.v3.pre-sqlite.bak`)).toBe(true);
    } finally {
      context.db.close();
    }
  });
});