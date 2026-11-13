import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ManagedRunDriver, ManagedRunHandle } from '../../src/adapter/managed-run-driver.js';
import { resolveAgentPaths } from '../../src/config/paths.js';
import { createDurableAgentRuntime } from '../../src/app/runtime.js';
import { AgentDatabase } from '../../src/storage/database.js';

const NOW = 1_762_432_800_000;

class NoopDriver implements ManagedRunDriver {
  starts = 0;
  startRun(): ManagedRunHandle {
    this.starts += 1;
    return {
      interrupt: async () => undefined,
      close: async () => undefined,
      resumeEvents: () => undefined,
    };
  }
}

function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), 's04-runtime-'));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 's04-runtime-ws-')));
  mkdtempSync(join(tmpdir(), 's04-runtime-unused-'));
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
  const driver = new NoopDriver();
  return { configDir, project, driver };
}

function runtimeOptions(configDir: string) {
  return {
    configDir,
    phoneListen: { host: '127.0.0.1', port: 0 },
  };
}

describe('durable runtime startup', () => {
  it('migrates, repairs and serves without starting any run', async () => {
    const { configDir, driver } = fixture();
    const runtime = await createDurableAgentRuntime(
      driver,
      runtimeOptions(configDir),
    );
    try {
      expect(runtime.recovery.interruptedRuns).toEqual([]);
      expect(driver.starts).toBe(0);
      const created = runtime.operations.createSession('ws_1', 'S04');
      expect(created.status).toBe('idle');
      const renamed = runtime.operations.renameSession(
        created.sessionId,
        'Renamed',
      );
      expect(renamed.title).toBe('Renamed');
      expect(runtime.operations.listSessions({ workspaceId: 'ws_1' }).sessions)
        .toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('persists sessions and blocks archive while recovery is required', async () => {
    const { configDir, driver } = fixture();
    const first = await createDurableAgentRuntime(
      driver,
      runtimeOptions(configDir),
    );
    const created = first.operations.createSession('ws_1', 'Pending recovery');
    const other = first.operations.createSession('ws_1', 'Other');
    await first.close();

    const databasePath = join(configDir, 'agent.sqlite3');
    const db = AgentDatabase.open(databasePath);
    try {
      db.immediate((tx) => {
        tx.prepare(
          `INSERT INTO runs
             (runId, sessionId, workspaceId, deviceId, commandId, traceId,
              status, promptText, promptExpiresAt, enqueueOrder,
              recoveryGeneration, pendingApprovalCount, outcomeUnknown,
              eventTailMayBeIncomplete, enqueuedAt)
           VALUES ('run_recover', ?, 'ws_1', 'device_1', 'cmd_r', 'trace_r',
                   'recovery_required', 'prompt', ?, 1, 1, 0, 0, 0, ?)`,
        ).run(created.sessionId, NOW + 1000, NOW);
      });
    } finally {
      db.close();
    }

    const second = await createDurableAgentRuntime(
      driver,
      runtimeOptions(configDir),
    );
    try {
      expect(second.operations.listSessions({ workspaceId: 'ws_1' }).sessions)
        .toHaveLength(2);
      expect(() => second.operations.archiveSession(created.sessionId)).toThrow(
        /SESSION_BUSY/,
      );
      const archived = second.operations.archiveSession(other.sessionId);
      expect(archived.status).toBe('archived');
    } finally {
      await second.close();
    }

    const third = await createDurableAgentRuntime(
      driver,
      runtimeOptions(configDir),
    );
    try {
      const sessions = third.operations.listSessions({
        workspaceId: 'ws_1',
        includeArchived: true,
      }).sessions;
      expect(
        sessions.find((session) => session.sessionId === other.sessionId)
          ?.status,
      ).toBe('archived');
      expect(
        sessions.find((session) => session.sessionId === created.sessionId)
          ?.status,
      ).toBe('idle');
    } finally {
      await third.close();
    }
  });

  it('rejects a second instance for the same execution environment', async () => {
    const { configDir, driver } = fixture();
    const first = await createDurableAgentRuntime(
      driver,
      runtimeOptions(configDir),
    );
    try {
      await expect(
        createDurableAgentRuntime(driver, runtimeOptions(configDir)),
      ).rejects.toThrow(/AGENT_ALREADY_RUNNING/);
    } finally {
      await first.close();
    }
    // 释放后可再次启动。
    const again = await createDurableAgentRuntime(
      driver,
      runtimeOptions(configDir),
    );
    await again.close();
  });

  it('fails closed before listening when V4 exists without a migrated DB', async () => {
    const { configDir, driver } = fixture();
    const paths = resolveAgentPaths(configDir);
    writeFileSync(
      paths.agentFile,
      JSON.stringify({
        version: 4,
        desktopId: 'desktop_1',
        database: { file: 'agent.sqlite3' },
        listen: { host: '127.0.0.1', port: 8787 },
        tailscale: { baseUrl: 'https://mac.example-tailnet.ts.net' },
      }),
      { mode: 0o600 },
    );
    await expect(
      createDurableAgentRuntime(driver, runtimeOptions(configDir)),
    ).rejects.toThrow(/STORAGE_MIGRATION_CONFLICT/);
  });
});