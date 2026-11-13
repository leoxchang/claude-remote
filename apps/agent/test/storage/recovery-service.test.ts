import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { RecoveryService } from '../../src/run/recovery-service.js';
import { PROMPT_TTL_MS } from '../../src/run/prompt-admission.js';
import { AgentDatabase } from '../../src/storage/database.js';
import {
  EventAppender,
  PersistentCommandExecutor,
} from '../../src/storage/persistent-command-executor.js';
import { RunRepository, StoredRun } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { SqliteWorkspaceRepository } from '../../src/storage/repositories/workspace-repository.js';

const NOW = 1_762_432_800_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's04-requeue-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const sessions = new SessionRepository(db.uow);
  const runs = new RunRepository(db.uow);
  const workspaces = new SqliteWorkspaceRepository(db.uow);
  const journal = new DurableEventJournal(db.uow, { now: () => NOW });
  const executor = new PersistentCommandExecutor({
    uow: db.uow,
    appender: journal as EventAppender,
  });
  const accepted: string[] = [];
  const service = new RecoveryService({
    executor,
    runs,
    sessions,
    workspaces,
    onAccepted: (result) => accepted.push(result.runId),
  });
  db.immediate((tx) => {
    tx.prepare(
      "INSERT INTO workspaces (workspaceId, displayName, rootPath, perSessionQueueLimit, mobileApprovalMode, createdAt) VALUES ('ws_1','W','/tmp/ws_1',2,'deny',1)",
    ).run();
    tx.prepare(
      "INSERT INTO scheduler_meta (key, value) VALUES ('nextEnqueueOrder', '1')",
    ).run();
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
  const run = (
    status: string,
    overrides: Partial<StoredRun> = {},
  ): StoredRun => {
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
      recoveryGeneration: 1,
      pendingApprovalCount: 0,
      outcomeUnknown: false,
      eventTailMayBeIncomplete: false,
      recoveryReason: 'agent_shutdown',
      enqueuedAt: NOW - 10_000,
      startedAt: null,
      endedAt: null,
      errorSummary: null,
      ...overrides,
    };
    runs.insert(record);
    return record;
  };
  return { db, runs, sessions, service, run, accepted };
}

function requeue(
  context: ReturnType<typeof setup>,
  run: StoredRun,
  overrides: Partial<{
    commandId: string;
    generation: number;
    sessionId: string;
  }> = {},
) {
  return context.service.requeue({
    identity: {
      commandId: overrides.commandId ?? 'cmd_requeue',
      type: 'run.requeue',
      sessionId: overrides.sessionId ?? 's1',
      runId: run.runId,
      payload: {
        expectedRecoveryGeneration: overrides.generation ?? run.recoveryGeneration,
      },
    },
    actor: { deviceId: 'device_1' },
    sessionId: overrides.sessionId ?? 's1',
    runId: run.runId,
    expectedRecoveryGeneration:
      overrides.generation ?? run.recoveryGeneration,
    now: NOW,
  });
}

describe('RecoveryService.requeue', () => {
  it('moves a recovery_required run to the tail without extending prompt', () => {
    const context = setup();
    try {
      const existing = context.run('queued');
      const recovering = context.run('recovery_required', {
        enqueueOrder: 0,
        enqueuedAt: NOW - 50_000,
      });
      const execution = requeue(context, recovering);

      expect(execution.duplicate).toBe(false);
      expect(execution.result).toEqual({
        sessionId: 's1',
        runId: recovering.runId,
        status: 'queued',
      });
      const stored = context.runs.get(recovering.runId);
      expect(stored).toMatchObject({
        status: 'queued',
        promptText: recovering.promptText,
        promptExpiresAt: recovering.promptExpiresAt,
        recoveryGeneration: 1,
        recoveryReason: null,
        enqueuedAt: NOW,
      });
      expect(stored?.enqueueOrder).toBeGreaterThan(existing.enqueueOrder);
      const event = context.db.connection
        .prepare("SELECT payloadJson FROM events WHERE type = 'run.queued'")
        .get() as { payloadJson: string };
      expect(JSON.parse(event.payloadJson)).toEqual({
        enqueuedAt: NOW,
        requeued: true,
        recoveryGeneration: 1,
        originalEnqueuedAt: recovering.enqueuedAt,
      });
      expect(event.payloadJson).not.toContain('prompt 2');
      expect(context.accepted).toEqual([recovering.runId]);
    } finally {
      context.db.close();
    }
  });

  it('rejects wrong status, generation, session, archive and empty prompt', () => {
    const context = setup();
    try {
      const running = context.run('running');
      expect(() => requeue(context, running)).toThrow(/RUN_NOT_RECOVERABLE/);

      const recovering = context.run('recovery_required');
      expect(() => requeue(context, recovering, { generation: 9 })).toThrow(
        /RECOVERY_GENERATION_CONFLICT/,
      );
      expect(() => requeue(context, recovering, { sessionId: 's2' })).toThrow(
        /RUN_SESSION_MISMATCH/,
      );

      const nullPrompt = context.run('recovery_required', {
        promptText: null,
      });
      expect(() => requeue(context, nullPrompt)).toThrow(/RUN_NOT_RECOVERABLE/);

      context.db.immediate((tx) =>
        tx
          .prepare("UPDATE sessions SET lifecycle = 'archived' WHERE sessionId = 's1'")
          .run(),
      );
      expect(() => requeue(context, recovering)).toThrow(/SESSION_ARCHIVED/);
      expect(context.runs.get(recovering.runId)?.status).toBe(
        'recovery_required',
      );
    } finally {
      context.db.close();
    }
  });

  it('enforces the current queue capacity', () => {
    const context = setup();
    try {
      context.run('queued');
      context.run('queued');
      const recovering = context.run('recovery_required', { enqueueOrder: 0 });
      expect(() => requeue(context, recovering)).toThrow(/QUEUE_FULL/);
      expect(context.runs.get(recovering.runId)?.status).toBe(
        'recovery_required',
      );
    } finally {
      context.db.close();
    }
  });

  it('replays the persisted first result for a duplicate requeue command', () => {
    const context = setup();
    try {
      const recovering = context.run('recovery_required');
      const first = requeue(context, recovering);
      const second = requeue(context, recovering);
      expect(second.duplicate).toBe(true);
      expect(second.result).toEqual(first.result);
      expect(
        context.db.connection
          .prepare("SELECT count(*) AS total FROM events WHERE type = 'run.queued'")
          .get(),
      ).toEqual({ total: 1 });
      expect(context.accepted).toEqual([recovering.runId]);
    } finally {
      context.db.close();
    }
  });
});