import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableApprovalStore } from '../../src/approval/durable-approval-store.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { SnapshotService } from '../../src/sync/snapshot-service.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { PersistentCommandExecutor } from '../../src/storage/persistent-command-executor.js';
import { CommandRepository } from '../../src/storage/repositories/command-repository.js';
import { RunRepository, StoredRun } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import {
  RetentionLimits,
  RetentionService,
} from '../../src/storage/retention-service.js';
import { StorageHealth } from '../../src/storage/storage-health.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_762_432_800_000;

function setup(limits: Partial<RetentionLimits> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 's04-retention-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const sessions = new SessionRepository(db.uow);
  const runs = new RunRepository(db.uow);
  const approvals = new DurableApprovalStore(db.uow, new DurableEventJournal(db.uow));
  const journal = new DurableEventJournal(db.uow, { now: () => clock.now });
  const executor = new PersistentCommandExecutor({ uow: db.uow, appender: journal });
  const snapshots = new SnapshotService({
    executor,
    journal,
    sessions,
    runs,
    approvals,
    uow: db.uow,
    now: () => clock.now,
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
    now: () => clock.now,
  });
  const clock = { now: NOW };
  db.immediate((tx) => {
    tx.prepare(
      "INSERT INTO workspaces (workspaceId, displayName, rootPath, createdAt) VALUES ('ws_1','W','/tmp/ws_1',1)",
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
  const append = (text: string): void => {
    journal.commit((_tx, appendEvent) =>
      appendEvent({
        sessionId: 's1',
        type: 'message.completed',
        payload: { text },
      }),
    );
  };
  const run = (status: string, overrides: Partial<StoredRun> = {}): StoredRun => {
    const record: StoredRun = {
      runId: `run_${Math.random().toString(36).slice(2)}`,
      sessionId: 's1',
      workspaceId: 'ws_1',
      deviceId: 'device_1',
      commandId: `cmd_${Math.random().toString(36).slice(2)}`,
      traceId: 'trace',
      status,
      promptText: 'prompt',
      promptExpiresAt: NOW + 30 * DAY,
      enqueueOrder: 1,
      recoveryGeneration: status === 'recovery_required' ? 1 : 0,
      pendingApprovalCount: 0,
      outcomeUnknown: false,
      eventTailMayBeIncomplete: false,
      recoveryReason: null,
      enqueuedAt: NOW,
      startedAt: null,
      endedAt: null,
      errorSummary: null,
      ...overrides,
    };
    runs.insert(record);
    return record;
  };
  return {
    db,
    clock,
    sessions,
    runs,
    journal,
    snapshots,
    retention,
    health,
    append,
    run,
  };
}

describe('RetentionService', () => {
  it('deletes only the oldest contiguous prefix and snapshots first', () => {
    const context = setup({ eventRetentionCount: 5 });
    try {
      for (let index = 0; index < 12; index += 1) context.append(`m${index}`);
      const report = context.retention.runOnce(NOW);
      expect(report.deletedEvents).toBe(7);
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM events WHERE sessionId = ?')
          .get('s1'),
      ).toEqual({ total: 5 });
      const seqs = context.db.connection
        .prepare('SELECT seq FROM events WHERE sessionId = ? ORDER BY seq')
        .all('s1') as { seq: number }[];
      expect(seqs.map((row) => row.seq)).toEqual([8, 9, 10, 11, 12]);
      expect(context.sessions.get('s1')?.retentionFloor).toBe(7);
      expect(
        context.db.connection
          .prepare("SELECT count(*) AS total FROM snapshots WHERE reason = 'retention'")
          .get(),
      ).toEqual({ total: 1 });
    } finally {
      context.db.close();
    }
  });

  it('removes events older than 30 days and respects the batch size', () => {
    const context = setup({ eventBatch: 2 });
    try {
      context.clock.now = NOW - 31 * DAY;
      context.append('old');
      context.clock.now = NOW;
      for (let index = 0; index < 4; index += 1) context.append(`new${index}`);

      const first = context.retention.runOnce(NOW);
      expect(first.deletedEvents).toBe(1);
      const second = context.retention.runOnce(NOW);
      expect(second.deletedEvents).toBe(0);
      const remaining = context.db.connection
        .prepare('SELECT seq FROM events ORDER BY seq')
        .all() as { seq: number }[];
      expect(remaining.map((row) => row.seq)).toEqual([2, 3, 4, 5]);
    } finally {
      context.db.close();
    }
  });

  it('expires queued and recovery prompts but only clears active prompt text', () => {
    const context = setup();
    try {
      const queued = context.run('queued', {
        promptExpiresAt: NOW - 1,
      });
      const recovery = context.run('recovery_required', {
        promptExpiresAt: NOW - 1,
      });
      const running = context.run('running', {
        promptExpiresAt: NOW - 1,
      });

      const report = context.retention.runOnce(NOW);
      expect(report.expiredPrompts).toBe(2);
      expect(context.runs.get(queued.runId)).toMatchObject({
        status: 'cancelled',
        promptText: null,
        errorSummary: 'retention_expired',
      });
      expect(context.runs.get(recovery.runId)).toMatchObject({
        status: 'cancelled',
        promptText: null,
      });
      expect(context.runs.get(running.runId)).toMatchObject({
        status: 'running',
        promptText: null,
      });
      expect(
        context.db.connection
          .prepare("SELECT count(*) AS total FROM events WHERE type = 'run.completed'")
          .get(),
      ).toEqual({ total: 2 });
    } finally {
      context.db.close();
    }
  });

  it('expires read-only results but never mutating results', async () => {
    const context = setup();
    try {
      const executor = new PersistentCommandExecutor({
        uow: context.db.uow,
        appender: context.journal,
      });
      executor.execute({
        identity: {
          commandId: 'cmd_read',
          type: 'session.sync',
          sessionId: 's1',
          payload: { afterSeq: 0 },
        },
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'read_only',
        now: NOW,
        business: () => ({ page: true }),
      });
      executor.execute({
        identity: {
          commandId: 'cmd_mutate',
          type: 'prompt.send',
          sessionId: 's1',
          payload: { text: 'x' },
        },
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating',
        now: NOW,
        business: () => ({ accepted: true }),
      });

      const report = context.retention.runOnce(NOW + 8 * DAY);
      expect(report.expiredCommands).toBe(1);
      const rows = context.db.connection
        .prepare('SELECT commandId, resultExpired FROM commands ORDER BY commandId')
        .all();
      expect(rows).toEqual([
        { commandId: 'cmd_mutate', resultExpired: 0 },
        { commandId: 'cmd_read', resultExpired: 1 },
      ]);
    } finally {
      context.db.close();
    }
  });

  it('trims terminal approvals after 90 days but keeps pending ones', () => {
    const context = setup();
    try {
      context.db.immediate((tx) => {
        const insert = tx.prepare(
          `INSERT INTO approvals
             (approvalId, requestKey, requestFingerprint, workspaceId, sessionId,
              runId, deviceId, toolUseID, toolName, status, createdAt, expiresAt, resolvedAt)
           VALUES (?, ?, 'f', 'ws_1', 's1', 'run', 'device_1', ?, 'Bash', ?, ?, ?, ?)`,
        );
        insert.run('old', 'rk_old', 'tu1', 'denied', 1, 2, NOW - 91 * DAY);
        insert.run('new', 'rk_new', 'tu2', 'denied', 1, 2, NOW - 10 * DAY);
        insert.run('pending', 'rk_pending', 'tu3', 'pending', 1, 2, null);
      });
      const report = context.retention.runOnce(NOW);
      expect(report.deletedApprovals).toBe(1);
      const ids = (
        context.db.connection
          .prepare('SELECT approvalId FROM approvals ORDER BY approvalId')
          .all() as { approvalId: string }[]
      ).map((row) => row.approvalId);
      expect(ids).toEqual(['new', 'pending']);
    } finally {
      context.db.close();
    }
  });

  it('keeps only the newest two snapshots per session', () => {
    const context = setup();
    try {
      context.append('one');
      const created: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        context.clock.now = NOW + index;
        context.db.immediate((tx) => {
          const manifest = context.snapshots.createWithin(tx, {
            sessionId: 's1',
            reason: 'sync',
          });
          created.push(manifest.snapshotId);
        });
      }
      context.clock.now = NOW + 10;
      expect(context.retention.runOnce(NOW).deletedSnapshots).toBe(1);
      const remaining = (
        context.db.connection
          .prepare('SELECT snapshotId FROM snapshots ORDER BY createdAt, snapshotId')
          .all() as { snapshotId: string }[]
      ).map((row) => row.snapshotId);
      expect(remaining).toHaveLength(2);
      expect(remaining).not.toContain(created[0]);
    } finally {
      context.db.close();
    }
  });

  it('degrades to limited above the soft limit', () => {
    const context = setup({ softLimitBytes: 1000, targetLimitBytes: 800 });
    try {
      expect(context.retention.evaluateCapacity(1001)).toBe('limited');
      expect(context.health.current().state).toBe('limited');
      expect(context.health.isAvailable()).toBe(false);
    } finally {
      context.db.close();
    }
  });
});