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
import { EventJournal } from '../../src/events/journal.js';
import { EventNormalizer } from '../../src/events/normalizer.js';
import { DurableRunController } from '../../src/run/durable-run-controller.js';
import { DurableRunScheduler } from '../../src/run/durable-run-scheduler.js';
import { PROMPT_TTL_MS } from '../../src/run/prompt-admission.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { RunRepository, StoredRun } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { SqliteWorkspaceRepository } from '../../src/storage/repositories/workspace-repository.js';

const NOW = 1_762_432_800_000;

class FakeHandle implements ManagedRunHandle {
  interrupted = false;
  closed = false;
  async interrupt(): Promise<void> {
    this.interrupted = true;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  resumeEvents(): void {}
}

class FakeDriver implements ManagedRunDriver {
  readonly starts: ManagedRunStart[] = [];
  readonly handles: FakeHandle[] = [];

  startRun(input: ManagedRunStart): ManagedRunHandle {
    this.starts.push(input);
    const handle = new FakeHandle();
    this.handles.push(handle);
    return handle;
  }

  emit(runId: string, event: Parameters<ManagedRunStart['onEvent']>[0]): void {
    const start = this.starts.find((entry) => entry.runId === runId);
    if (start === undefined) throw new Error('run was not started');
    start.onEvent(event);
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's04-controller-'));
  const project = mkdtempSync(join(tmpdir(), 's04-controller-ws-'));
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
  const invalidated: string[] = [];
  const controller = new DurableRunController({
    scheduler,
    sessions,
    normalizer: new EventNormalizer(new EventJournal()),
    permissionBroker: {
      invalidateRun: (runId) => {
        invalidated.push(runId);
        return 0;
      },
    },
  });
  db.immediate((tx) => {
    tx.prepare(
      "INSERT INTO workspaces (workspaceId, displayName, rootPath, perSessionQueueLimit, mobileApprovalMode, createdAt) VALUES ('ws_1','W',?,20,'deny',1)",
    ).run(realpathSync(project));
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
  const run: StoredRun = {
    runId: 'run_1',
    sessionId: 's1',
    workspaceId: 'ws_1',
    deviceId: 'device_1',
    commandId: 'cmd_1',
    traceId: 'trace_1',
    status: 'queued',
    promptText: 'S04_CONTROLLER_PROMPT',
    promptExpiresAt: NOW + PROMPT_TTL_MS,
    enqueueOrder: 1,
    recoveryGeneration: 0,
    pendingApprovalCount: 0,
    outcomeUnknown: false,
    eventTailMayBeIncomplete: false,
    recoveryReason: null,
    enqueuedAt: NOW,
    startedAt: null,
    endedAt: null,
    errorSummary: null,
  };
  runs.insert(run);
  scheduler.drain();
  return { db, sessions, runs, scheduler, driver, controller, invalidated, run };
}

describe('DurableRunController', () => {
  it('records the Claude session and marks running on init', () => {
    const context = setup();
    try {
      context.driver.emit(context.run.runId, {
        kind: 'init',
        sessionId: 's1',
        runId: context.run.runId,
        claudeSessionId: 'claude_resumed',
      });
      expect(context.sessions.get('s1')?.claudeSessionId).toBe('claude_resumed');
      expect(context.runs.get(context.run.runId)?.status).toBe('running');
    } finally {
      context.db.close();
    }
  });

  it('completes the run on runResult and clears the prompt', async () => {
    const context = setup();
    try {
      context.driver.emit(context.run.runId, {
        kind: 'runResult',
        sessionId: 's1',
        runId: context.run.runId,
        status: 'succeeded',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(context.runs.get(context.run.runId)?.status).toBe('succeeded');
      expect(context.runs.get(context.run.runId)?.promptText).toBeNull();
      expect(context.scheduler.activeCount()).toBe(0);
    } finally {
      context.db.close();
    }
  });

  it('invalidates approvals before interrupting on cancel', async () => {
    const context = setup();
    try {
      const accepted = await context.controller.cancel(context.run.runId);
      expect(accepted).toEqual({
        sessionId: 's1',
        runId: 'run_1',
        status: 'cancelling',
      });
      expect(context.invalidated).toEqual(['run_1']);
      expect(context.driver.handles[0]?.interrupted).toBe(true);
      expect(context.runs.get(context.run.runId)?.status).toBe('cancelling');
    } finally {
      context.db.close();
    }
  });

  it('ignores events from an older generation', () => {
    const context = setup();
    try {
      const stale = { runId: context.run.runId, generation: 99 };
      context.scheduler.setEventHandler((_event, _context) => undefined);
      // 旧 generation 的 handle 事件不会通过 scheduler 的 isCurrent 检查。
      expect(
        context.scheduler.isCurrent(stale.runId, stale.generation),
      ).toBe(false);
      expect(context.runs.get(context.run.runId)?.status).toBe('starting');
    } finally {
      context.db.close();
    }
  });
});