import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ManagedRunDriver,
  ManagedRunHandle,
  ManagedRunStart,
} from '../../src/adapter/managed-run-driver.js';
import { AdapterRegistry } from '../../src/adapter/adapter-registry.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { DurableRunScheduler } from '../../src/run/durable-run-scheduler.js';
import { PROMPT_TTL_MS } from '../../src/run/prompt-admission.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { RunRepository, StoredRun } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { SqliteWorkspaceRepository } from '../../src/storage/repositories/workspace-repository.js';

const NOW = 1_762_432_800_000;

class FakeHandle implements ManagedRunHandle {
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
  resumeEvents(): void {}
}

class FakeDriver implements ManagedRunDriver {
  readonly starts: ManagedRunStart[] = [];
  startRun(input: ManagedRunStart): ManagedRunHandle {
    this.starts.push(input);
    return new FakeHandle();
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's04-scheduler-branches-'));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 's04-scheduler-ws-')));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const sessions = new SessionRepository(db.uow);
  const runs = new RunRepository(db.uow);
  const workspaces = new SqliteWorkspaceRepository(db.uow);
  const journal = new DurableEventJournal(db.uow, { now: () => NOW });
  const driver = new FakeDriver();
  const scheduler = new DurableRunScheduler({
    uow: db.uow,
    sessions,
    runs,
    workspaces,
    journal,
    driver,
    registry: new AdapterRegistry(),
    now: () => NOW,
  });
  db.immediate((tx) => {
    tx.prepare(
      "INSERT INTO workspaces (workspaceId, displayName, rootPath, perSessionQueueLimit, mobileApprovalMode, createdAt) VALUES ('ws_1','W',?,20,'deny',1)",
    ).run(project);
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
  let counter = 0;
  const run = (status: string, overrides: Partial<StoredRun> = {}): StoredRun => {
    counter += 1;
    const record: StoredRun = {
      runId: `run_${counter}`,
      sessionId: 's1',
      workspaceId: 'ws_1',
      deviceId: 'device_1',
      commandId: `cmd_${counter}`,
      traceId: 'trace',
      status,
      promptText: 'prompt',
      promptExpiresAt: NOW + PROMPT_TTL_MS,
      enqueueOrder: counter,
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
  return { db, sessions, runs, scheduler, driver, run, project };
}

describe('DurableRunScheduler branches', () => {
  it('discards recovery_required and rejects removing active runs', () => {
    const context = setup();
    try {
      const recovering = context.run('recovery_required');
      expect(context.scheduler.removeQueued(recovering.runId)).toMatchObject({
        status: 'cancelled',
        removed: true,
      });
      expect(context.runs.get(recovering.runId)?.status).toBe('cancelled');

      const running = context.run('running');
      expect(() => context.scheduler.removeQueued(running.runId)).toThrow(
        /RUN_NOT_QUEUED/,
      );
      expect(() => context.scheduler.removeQueued('missing')).toThrow(
        /RUN_NOT_FOUND/,
      );
    } finally {
      context.db.close();
    }
  });

  it('handles cancel decisions for cancelling, terminal and missing runs', () => {
    const context = setup();
    try {
      const cancelling = context.run('cancelling');
      expect(context.scheduler.beginCancel(cancelling.runId).outcome).toBe(
        'alreadyCancelling',
      );

      const done = context.run('succeeded');
      expect(() => context.scheduler.beginCancel(done.runId)).toThrow(
        /RUN_NOT_ACTIVE/,
      );
      expect(() => context.scheduler.beginCancel('missing')).toThrow(
        /RUN_NOT_FOUND/,
      );
    } finally {
      context.db.close();
    }
  });

  it('exposes approval context for active runs, cancelling and terminal states', () => {
    const context = setup();
    try {
      const running = context.run('running');
      expect(context.scheduler.approvalContext(running.runId)).toMatchObject({
        acceptingApprovals: true,
      });

      const cancelling = context.run('cancelling');
      expect(context.scheduler.approvalContext(cancelling.runId)).toMatchObject({
        acceptingApprovals: false,
      });

      const done = context.run('succeeded');
      expect(context.scheduler.approvalContext(done.runId)).toBeNull();
      expect(context.scheduler.approvalContext('missing')).toBeNull();

      const removed = context.run('running', { workspaceId: 'missing_ws' });
      expect(context.scheduler.approvalContext(removed.runId)).toBeNull();
    } finally {
      context.db.close();
    }
  });

  it('updates pending counts for waiting and zero transitions', () => {
    const context = setup();
    try {
      const run = context.run('running');
      context.scheduler.setPendingApprovalCount(run.runId, 1);
      expect(context.runs.get(run.runId)?.status).toBe('waiting_approval');
      context.scheduler.setPendingApprovalCount(run.runId, 0);
      expect(context.runs.get(run.runId)?.status).toBe('running');
      context.scheduler.setPendingApprovalCount('missing', 1);
      context.scheduler.setPendingApprovalCount(run.runId, 0);
    } finally {
      context.db.close();
    }
  });

  it('ignores markRunning for missing or terminal runs and completes once', () => {
    const context = setup();
    try {
      context.scheduler.markRunning('missing');
      const done = context.run('succeeded');
      context.scheduler.markRunning(done.runId);
      expect(context.runs.get(done.runId)?.status).toBe('succeeded');

      expect(() =>
        context.scheduler.complete({ runId: 'missing', status: 'succeeded' }),
      ).toThrow(/RUN_NOT_FOUND/);
      const running = context.run('running');
      context.scheduler.complete({ runId: running.runId, status: 'failed' });
      context.scheduler.complete({ runId: running.runId, status: 'failed' });
      expect(context.runs.get(running.runId)?.status).toBe('failed');
    } finally {
      context.db.close();
    }
  });

  it('terminates queued runs whose workspace path is gone', () => {
    const context = setup();
    try {
      const run = context.run('queued');
      context.db.immediate((tx) =>
        tx
          .prepare("UPDATE workspaces SET rootPath = '/definitely/missing' WHERE workspaceId = 'ws_1'")
          .run(),
      );
      context.scheduler.drain();
      expect(context.runs.get(run.runId)?.status).toBe('failed');
      expect(context.runs.get(run.runId)?.errorSummary).toBe(
        'WORKSPACE_NOT_ALLOWED',
      );
      expect(context.driver.starts).toEqual([]);
    } finally {
      context.db.close();
    }
  });

  it('projects queued and recovery lists and reports degraded state', () => {
    const context = setup();
    try {
      const queued = context.run('queued');
      const recovering = context.run('recovery_required');
      expect(context.scheduler.queuedRuns('s1')).toHaveLength(1);
      expect(context.scheduler.queuedRuns('s1')[0]?.runId).toBe(queued.runId);
      expect(context.scheduler.recoveryRequiredRuns()).toHaveLength(1);
      expect(context.scheduler.recoveryRequiredRuns()[0]?.runId).toBe(
        recovering.runId,
      );
      expect(context.scheduler.isDegraded()).toBe(false);
      expect(context.scheduler.handle(queued.runId)).toBeNull();
    } finally {
      context.db.close();
    }
  });
});