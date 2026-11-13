import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableApprovalStore } from '../../src/approval/durable-approval-store.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { PromptAdmission } from '../../src/run/prompt-admission.js';
import { RecoveryService } from '../../src/run/recovery-service.js';
import { SnapshotService } from '../../src/sync/snapshot-service.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { PersistentCommandExecutor } from '../../src/storage/persistent-command-executor.js';
import { CommandRepository } from '../../src/storage/repositories/command-repository.js';
import { RunRepository } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { SqliteWorkspaceRepository } from '../../src/storage/repositories/workspace-repository.js';
import { RetentionService } from '../../src/storage/retention-service.js';
import { StorageHealth } from '../../src/storage/storage-health.js';

const NOW = 1_762_432_800_000;

function setup(limits: Partial<import('../../src/storage/retention-service.js').RetentionLimits> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 's04-capacity-'));
  const path = join(dir, 'agent.sqlite3');
  const db = AgentDatabase.open(path);
  const sessions = new SessionRepository(db.uow);
  const runs = new RunRepository(db.uow);
  const workspaces = new SqliteWorkspaceRepository(db.uow);
  const journal = new DurableEventJournal(db.uow, { now: () => NOW });
  const approvals = new DurableApprovalStore(db.uow, journal);
  const executor = new PersistentCommandExecutor({ uow: db.uow, appender: journal });
  const snapshots = new SnapshotService({
    executor,
    journal,
    sessions,
    runs,
    approvals,
    uow: db.uow,
    now: () => NOW,
  });
  const health = new StorageHealth();
  const retention = new RetentionService({
    uow: db.uow,
    journal,
    runs,
    sessions,
    commands: new CommandRepository(db.uow),
    snapshots,
    health,
    limits,
    now: () => NOW,
  });
  const admission = new PromptAdmission({
    executor,
    sessions,
    runs,
    workspaces,
    health,
  });
  const recovery = new RecoveryService({
    executor,
    runs,
    sessions,
    workspaces,
    health,
  });
  db.immediate((tx) => {
    tx.prepare(
      "INSERT INTO workspaces (workspaceId, displayName, rootPath, perSessionQueueLimit, mobileApprovalMode, createdAt) VALUES ('ws_1','W','/tmp/ws_1',20,'deny',1)",
    ).run();
    sessions.create({
      sessionId: 's1',
      workspaceId: 'ws_1',
      claudeSessionId: null,
      title: 'One',
      lifecycle: 'active',
      status: 'idle',
      lastSeq: 0,
      retentionFloor: 0,
      createdAt: 1,
      lastActivityAt: 1,
      archivedAt: null,
    });
  });
  return { db, path, retention, health, admission, recovery };
}

describe('storage capacity', () => {
  it('measures live pages instead of the never-shrinking file length', () => {
    const context = setup();
    try {
      context.db.immediate((tx) => {
        tx.exec('CREATE TABLE capacity_probe (id INTEGER PRIMARY KEY, body BLOB)');
        tx.prepare('INSERT INTO capacity_probe (body) VALUES (?)').run(
          Buffer.alloc(2 * 1024 * 1024),
        );
      });
      context.db.connection.pragma('wal_checkpoint(TRUNCATE)');
      const allocated = context.db.liveBytes();
      const fileSize = statSync(context.path).size;
      context.db.immediate((tx) => tx.exec('DELETE FROM capacity_probe'));
      context.db.connection.pragma('wal_checkpoint(TRUNCATE)');
      const after = context.db.liveBytes();
      expect(after).toBeLessThan(allocated);
      // 不自动 VACUUM：主文件长度不变，但 live pages 已下降。
      expect(statSync(context.path).size).toBe(fileSize);
      expect(after).toBeLessThan(fileSize);
    } finally {
      context.db.close();
    }
  });

  it('marks storage limited and rejects new execution intents', () => {
    const context = setup({ softLimitBytes: 1, targetLimitBytes: 0 });
    try {
      expect(context.retention.evaluateCapacity(2)).toBe('limited');
      expect(context.health.isAvailable()).toBe(false);

      expect(() =>
        context.admission.send({
          identity: {
            commandId: 'cmd_limited',
            type: 'prompt.send',
            sessionId: 's1',
            payload: { text: 'x' },
          },
          actor: { deviceId: 'device_1' },
          text: 'x',
          traceId: 'trace',
          now: NOW,
        }),
      ).toThrow(/STORAGE_LIMITED/);

      expect(() =>
        context.recovery.requeue({
          identity: {
            commandId: 'cmd_requeue_limited',
            type: 'run.requeue',
            sessionId: 's1',
            runId: 'run_1',
            payload: { expectedRecoveryGeneration: 1 },
          },
          actor: { deviceId: 'device_1' },
          sessionId: 's1',
          runId: 'run_1',
          expectedRecoveryGeneration: 1,
          now: NOW,
        }),
      ).toThrow(/STORAGE_LIMITED/);
    } finally {
      context.db.close();
    }
  });

  it('never deletes mutating idempotency rows during retention', () => {
    const context = setup({ eventRetentionCount: 1 });
    try {
      const executor = new PersistentCommandExecutor({
        uow: context.db.uow,
        appender: new DurableEventJournal(context.db.uow, { now: () => NOW }),
      });
      executor.execute({
        identity: {
          commandId: 'cmd_keep',
          type: 'prompt.send',
          sessionId: 's1',
          payload: { text: 'keep' },
        },
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating',
        now: NOW,
        business: () => ({ accepted: true }),
      });
      context.retention.runOnce(NOW + 365 * 24 * 60 * 60 * 1000);
      expect(
        context.db.connection
          .prepare("SELECT count(*) AS total FROM commands WHERE commandId = 'cmd_keep'")
          .get(),
      ).toEqual({ total: 1 });
    } finally {
      context.db.close();
    }
  });
});