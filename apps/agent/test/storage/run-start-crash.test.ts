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
  closed = false;
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  resumeEvents(): void {}
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

function setup(options: { journal?: DurableEventJournal } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 's04-crash-'));
  const project = mkdtempSync(join(tmpdir(), 's04-crash-ws-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const sessions = new SessionRepository(db.uow);
  const runs = new RunRepository(db.uow);
  const workspaces = new SqliteWorkspaceRepository(db.uow);
  const journal =
    options.journal ?? new DurableEventJournal(db.uow, { now: () => NOW });
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
    ).run(realpathSync(project));
    sessions.create({
      sessionId: 's1',
      workspaceId: 'ws_1',
      claudeSessionId: 'claude_1',
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
  const insertQueued = (overrides: Partial<StoredRun> = {}): StoredRun => {
    counter += 1;
    const run: StoredRun = {
      runId: `run_${counter}`,
      sessionId: 's1',
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
  return { db, sessions, runs, scheduler, driver, insertQueued };
}

describe('run start crash windows', () => {
  it('never returns a committed starting run to queued after process loss', () => {
    const context = setup();
    try {
      const run = context.insertQueued();
      const started = context.scheduler.beginStart(run.runId, NOW);
      expect(started).not.toBeNull();
      expect(started).not.toBe('expired');
      expect(context.runs.get(run.runId)?.status).toBe('starting');

      // 模拟重启：新 scheduler 面对同一 DB，不得把 starting 当 queued 重放。
      const restarted = new DurableRunScheduler({
        uow: context.db.uow,
        sessions: new SessionRepository(context.db.uow),
        runs: new RunRepository(context.db.uow),
        workspaces: new SqliteWorkspaceRepository(context.db.uow),
        journal: new DurableEventJournal(context.db.uow, { now: () => NOW }),
        driver: new FakeDriver(),
        registry: new AdapterRegistry(),
        now: () => NOW,
      });
      restarted.drain();
      expect(restarted.activeCount()).toBe(1);
      expect(context.runs.get(run.runId)?.status).toBe('starting');
    } finally {
      context.db.close();
    }
  });

  it('marks a synchronous driver failure once and frees the slot', () => {
    const context = setup();
    try {
      const first = context.insertQueued();
      context.driver.throwOnStart = true;
      context.scheduler.drain();
      expect(context.runs.get(first.runId)?.status).toBe('failed');
      expect(context.runs.get(first.runId)?.errorSummary).toBe(
        'RUN_START_FAILED',
      );
      expect(context.scheduler.activeCount()).toBe(0);

      const second = context.insertQueued();
      context.driver.throwOnStart = false;
      context.scheduler.drain();
      expect(context.runs.get(second.runId)?.status).toBe('starting');
      expect(context.driver.starts).toHaveLength(1);
    } finally {
      context.db.close();
    }
  });

  it('closes the handle and stops starting when run.started cannot persist', () => {
    const failingJournal = {
      appendWithin: () => {
        throw new Error('disk full');
      },
    } as unknown as DurableEventJournal;
    const context = setup({ journal: failingJournal });
    try {
      const first = context.insertQueued();
      const second = context.insertQueued();
      context.scheduler.drain();

      expect(context.scheduler.isDegraded()).toBe(true);
      expect(context.driver.starts).toHaveLength(1);
      expect(context.driver.handles[0]?.closed).toBe(true);
      expect(context.runs.get(first.runId)?.status).toBe('starting');
      // degraded 后不再启动新 run。
      context.scheduler.drain();
      expect(context.driver.starts).toHaveLength(1);
      expect(context.runs.get(second.runId)?.status).toBe('queued');
    } finally {
      context.db.close();
    }
  });
});