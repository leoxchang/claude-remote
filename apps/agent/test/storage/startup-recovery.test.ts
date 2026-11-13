import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { PROMPT_TTL_MS } from '../../src/run/prompt-admission.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { ApprovalRepository } from '../../src/storage/repositories/approval-repository.js';
import { RunRepository, StoredRun } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { StartupRecovery } from '../../src/storage/startup-recovery.js';

const NOW = 1_762_432_800_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's04-recovery-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const sessions = new SessionRepository(db.uow);
  const runs = new RunRepository(db.uow);
  const approvals = new ApprovalRepository(db.uow);
  const journal = new DurableEventJournal(db.uow, { now: () => NOW });
  const recovery = new StartupRecovery({
    uow: db.uow,
    journal,
    runs,
    sessions,
    approvals,
    now: () => NOW,
  });
  db.immediate((tx) => {
    tx.prepare(
      "INSERT INTO workspaces (workspaceId, displayName, rootPath, createdAt) VALUES ('ws_1','W','/tmp/ws_1',1)",
    ).run();
    sessions.create({
      sessionId: 's1',
      workspaceId: 'ws_1',
      claudeSessionId: 'claude_1',
      title: 'Kept title',
      lifecycle: 'active',
      status: 'running',
      lastSeq: 0,
      retentionFloor: 0,
      createdAt: 1,
      lastActivityAt: 1,
      archivedAt: null,
    });
  });
  let counter = 0;
  const run = (status: string, overrides: Partial<StoredRun> = {}): StoredRun => {
    counter += 1;
    const record: StoredRun = {
      runId: `run_${counter}`,
      sessionId: 's1',
      workspaceId: 'ws_1',
      deviceId: 'device_1',
      commandId: `cmd_${counter}`,
      traceId: `trace_${counter}`,
      status,
      promptText: `prompt ${counter}`,
      promptExpiresAt: NOW + PROMPT_TTL_MS,
      enqueueOrder: counter,
      recoveryGeneration: 0,
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
  const approval = (status: string, index: number): void => {
    db.immediate((tx) => {
      tx.prepare(
        `INSERT INTO approvals
           (approvalId, requestKey, requestFingerprint, workspaceId, sessionId,
            runId, deviceId, toolUseID, toolName, status, createdAt, expiresAt)
         VALUES (?, ?, 'f', 'ws_1', 's1', ?, 'device_1', ?, 'Bash', ?, ?, ?)`,
      ).run(
        `approval_${index}`,
        `rk_${index}`,
        `run_${index}`,
        `toolu_${index}`,
        status,
        NOW,
        NOW + 120_000,
      );
    });
  };
  return { db, sessions, runs, approvals, journal, recovery, run, approval };
}

describe('StartupRecovery', () => {
  it('repairs queued, active and pending records in one transaction', () => {
    const context = setup();
    try {
      const queued = context.run('queued');
      const starting = context.run('starting');
      const running = context.run('running');
      const waiting = context.run('waiting_approval');
      const cancelling = context.run('cancelling');
      const finished = context.run('succeeded', { endedAt: NOW - 1 });
      context.approval('pending', 1);
      context.approval('approved_once', 2);
      context.approval('denied', 3);

      const report = context.recovery.repair({ agentInstanceId: 'agent_new' });

      expect(report.recoveredQueuedRuns).toEqual([queued.runId]);
      expect(report.interruptedRuns.sort()).toEqual(
        [starting.runId, running.runId, waiting.runId, cancelling.runId].sort(),
      );
      expect(report.invalidatedApprovals).toEqual(['approval_1']);
      expect(context.sessions.get('s1')).toMatchObject({
        claudeSessionId: 'claude_1',
        title: 'Kept title',
        status: 'idle',
      });

      const repairedQueued = context.runs.get(queued.runId);
      expect(repairedQueued).toMatchObject({
        status: 'recovery_required',
        recoveryGeneration: 1,
        recoveryReason: 'agent_shutdown',
        promptText: queued.promptText,
      });
      for (const runId of [
        starting.runId,
        running.runId,
        waiting.runId,
        cancelling.runId,
      ]) {
        expect(context.runs.get(runId)).toMatchObject({
          status: 'interrupted',
          outcomeUnknown: true,
          eventTailMayBeIncomplete: true,
          promptText: null,
        });
      }
      expect(context.runs.get(finished.runId)?.status).toBe('succeeded');

      const statuses = context.db.connection
        .prepare('SELECT approvalId, status FROM approvals ORDER BY approvalId')
        .all();
      expect(statuses).toEqual([
        { approvalId: 'approval_1', status: 'invalidated' },
        { approvalId: 'approval_2', status: 'approved_once' },
        { approvalId: 'approval_3', status: 'denied' },
      ]);

      const events = context.db.connection
        .prepare('SELECT type, count(*) AS total FROM events GROUP BY type ORDER BY type')
        .all();
      expect(events).toEqual([
        { type: 'permission.resolved', total: 1 },
        { type: 'run.completed', total: 4 },
        { type: 'run.recovery_required', total: 1 },
      ]);
      const seqs = context.db.connection
        .prepare('SELECT seq FROM events WHERE sessionId = ? ORDER BY seq')
        .all('s1') as { seq: number }[];
      expect(seqs.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(
        context.db.connection
          .prepare("SELECT value FROM scheduler_meta WHERE key = 'agentInstanceId'")
          .get(),
      ).toEqual({ value: 'agent_new' });

      // 第二次修复不再产生事件。
      const second = context.recovery.repair({ agentInstanceId: 'agent_newer' });
      expect(second.interruptedRuns).toEqual([]);
      expect(second.invalidatedApprovals).toEqual([]);
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM events')
          .get(),
      ).toEqual({ total: 6 });
    } finally {
      context.db.close();
    }
  });

  it('rolls back the whole repair when an event append fails', () => {
    const context = setup();
    try {
      const queued = context.run('queued');
      const running = context.run('running');
      let appends = 0;
      const failing = {
        appendWithin: (
          tx: Parameters<DurableEventJournal['appendWithin']>[0],
          input: Parameters<DurableEventJournal['appendWithin']>[1],
        ) => {
          appends += 1;
          if (appends === 2) throw new Error('disk full');
          return context.journal.appendWithin(tx, input);
        },
      } as unknown as DurableEventJournal;
      const failingRecovery = new StartupRecovery({
        uow: context.db.uow,
        journal: failing,
        runs: context.runs,
        sessions: context.sessions,
        approvals: context.approvals,
        now: () => NOW,
      });

      expect(() =>
        failingRecovery.repair({ agentInstanceId: 'agent_x' }),
      ).toThrow(/STORAGE_UNAVAILABLE/);
      expect(context.runs.get(queued.runId)?.status).toBe('queued');
      expect(context.runs.get(running.runId)?.status).toBe('running');
      expect(
        context.db.connection.prepare('SELECT count(*) AS total FROM events').get(),
      ).toEqual({ total: 0 });

      // 重试可完整完成。
      const report = context.recovery.repair({ agentInstanceId: 'agent_y' });
      expect(report.recoveredQueuedRuns).toEqual([queued.runId]);
      expect(report.interruptedRuns).toEqual([running.runId]);
    } finally {
      context.db.close();
    }
  });
});