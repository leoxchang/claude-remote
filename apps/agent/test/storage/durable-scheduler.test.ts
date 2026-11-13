import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ManagedRunDriver,
  ManagedRunHandle,
  ManagedRunStart,
} from '../../src/adapter/managed-run-driver.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { DurableRunScheduler } from '../../src/run/durable-run-scheduler.js';
import { PROMPT_TTL_MS } from '../../src/run/prompt-admission.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { RunRepository, StoredRun } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { SqliteWorkspaceRepository } from '../../src/storage/repositories/workspace-repository.js';
import { AdapterRegistry } from '../../src/adapter/adapter-registry.js';

const NOW = 1_762_432_800_000;

class FakeHandle implements ManagedRunHandle {
  interrupted = false;
  closed = false;
  resumed = false;

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  resumeEvents(): void {
    this.resumed = true;
  }
}

class FakeDriver implements ManagedRunDriver {
  readonly starts: ManagedRunStart[] = [];
  readonly handles: FakeHandle[] = [];
  throwOnStart = false;

  startRun(input: ManagedRunStart): ManagedRunHandle {
    if (this.throwOnStart) throw new Error('driver failed');
    this.starts.push(input);
    const handle = new FakeHandle();
    this.handles.push(handle);
    return handle;
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's04-scheduler-'));
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
  const project = mkdtempSync(join(tmpdir(), 's04-ws-'));
  db.immediate((tx) => {
    tx.prepare(
      "INSERT INTO workspaces (workspaceId, displayName, rootPath, perSessionQueueLimit, mobileApprovalMode, createdAt) VALUES ('ws_1','W',?,20,'deny',1)",
    ).run(realpathSync(project));
    for (const sessionId of ['s1', 's2', 's3']) {
      sessions.create({
        sessionId,
        workspaceId: 'ws_1',
        claudeSessionId: `claude_${sessionId}`,
        title: sessionId,
        lifecycle: 'active',
        status: 'idle',
        lastSeq: 0,
        retentionFloor: 0,
        createdAt: 1,
        lastActivityAt: 1,
        archivedAt: null,
      });
    }
  });
  let counter = 0;
  const insertQueued = (
    sessionId: string,
    overrides: Partial<StoredRun> = {},
  ): StoredRun => {
    counter += 1;
    const run: StoredRun = {
      runId: `run_${counter}`,
      sessionId,
      workspaceId: 'ws_1',
      deviceId: 'device_1',
      commandId: `cmd_${counter}`,
      traceId: `trace_${counter}`,
      status: 'queued',
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
    runs.insert(run);
    return run;
  };
  return { db, sessions, runs, journal, driver, scheduler, insertQueued };
}

describe('DurableRunScheduler', () => {
  it('runs two sessions concurrently and keeps per-session FIFO', () => {
    const context = setup();
    try {
      const a1 = context.insertQueued('s1');
      const b1 = context.insertQueued('s2');
      const a2 = context.insertQueued('s1', { runId: 'run_a2' });
      context.scheduler.drain();

      expect(context.driver.starts.map((start) => start.runId)).toEqual([
        a1.runId,
        b1.runId,
      ]);
      expect(context.runs.get(a1.runId)?.status).toBe('starting');
      expect(context.runs.get(b1.runId)?.status).toBe('starting');
      expect(context.runs.get(a2.runId)?.status).toBe('queued');
      expect(context.scheduler.activeCount()).toBe(2);

      context.scheduler.complete({ runId: a1.runId, status: 'succeeded' });
      expect(context.driver.starts.map((start) => start.runId)).toEqual([
        a1.runId,
        b1.runId,
        a2.runId,
      ]);
      expect(context.runs.get(a2.runId)?.status).toBe('starting');
    } finally {
      context.db.close();
    }
  });

  it('keeps waiting_approval runs occupying execution slots', () => {
    const context = setup();
    try {
      const a1 = context.insertQueued('s1');
      const b1 = context.insertQueued('s2');
      const c1 = context.insertQueued('s3');
      context.scheduler.drain();
      context.scheduler.setPendingApprovalCount(a1.runId, 1);

      expect(context.runs.get(a1.runId)?.status).toBe('waiting_approval');
      context.scheduler.drain();
      expect(context.runs.get(c1.runId)?.status).toBe('queued');
      expect(context.driver.starts).toHaveLength(2);

      context.scheduler.complete({ runId: b1.runId, status: 'succeeded' });
      expect(context.runs.get(c1.runId)?.status).toBe('starting');
    } finally {
      context.db.close();
    }
  });

  it('atomically cancels expired queued prompts without touching the driver', () => {
    const context = setup();
    try {
      const expired = context.insertQueued('s1', {
        promptExpiresAt: NOW - 1,
      });
      const nullText = context.insertQueued('s1', {
        promptText: null,
      });
      const valid = context.insertQueued('s1');
      context.scheduler.drain();

      expect(context.runs.get(expired.runId)?.status).toBe('cancelled');
      expect(context.runs.get(nullText.runId)?.status).toBe('cancelled');
      expect(context.runs.get(valid.runId)?.status).toBe('starting');
      expect(context.driver.starts.map((start) => start.runId)).toEqual([
        valid.runId,
      ]);
      const completed = context.journal
        .recent('s1', 10)
        .filter((event) => event.type === 'run.completed');
      expect(completed).toHaveLength(2);
      expect(completed[0]?.payload).toMatchObject({
        status: 'cancelled',
        reason: 'retention_expired',
      });
    } finally {
      context.db.close();
    }
  });

  it('never schedules recovery_required runs', () => {
    const context = setup();
    try {
      const recovering = context.insertQueued('s1', {
        status: 'recovery_required',
        recoveryGeneration: 1,
      });
      context.scheduler.drain();
      expect(context.driver.starts).toEqual([]);
      expect(context.scheduler.recoveryRequiredRuns()).toHaveLength(1);
      expect(context.runs.get(recovering.runId)?.status).toBe('recovery_required');
    } finally {
      context.db.close();
    }
  });

  it('clears promptText on terminal completion', () => {
    const context = setup();
    try {
      const run = context.insertQueued('s1');
      context.scheduler.drain();
      context.scheduler.complete({ runId: run.runId, status: 'failed' });
      expect(context.runs.get(run.runId)?.promptText).toBeNull();
      expect(
        JSON.stringify(context.journal.recent('s1', 10)),
      ).not.toContain('prompt 1');
    } finally {
      context.db.close();
    }
  });
});