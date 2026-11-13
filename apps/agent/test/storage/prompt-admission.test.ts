import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CommandIdentity } from '../../src/command/canonical-request.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { PromptAdmission, PROMPT_TTL_MS } from '../../src/run/prompt-admission.js';
import { AgentDatabase } from '../../src/storage/database.js';
import {
  AppendEvent,
  EventAppender,
  PersistentCommandExecutor,
} from '../../src/storage/persistent-command-executor.js';
import { RunRepository } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { SqliteWorkspaceRepository } from '../../src/storage/repositories/workspace-repository.js';
import { SqliteTransaction } from '../../src/storage/unit-of-work.js';

const NOW = 1_762_432_800_000;

function setup(options: { queueLimit?: number; appender?: EventAppender } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 's04-admission-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const sessions = new SessionRepository(db.uow);
  const runs = new RunRepository(db.uow);
  const workspaces = new SqliteWorkspaceRepository(db.uow);
  const journal = new DurableEventJournal(db.uow, { now: () => NOW });
  const accepted: string[] = [];
  const executor = new PersistentCommandExecutor({
    uow: db.uow,
    appender: options.appender ?? journal,
  });
  const admission = new PromptAdmission({
    executor,
    sessions,
    runs,
    workspaces,
    generateRunId: (() => {
      let counter = 0;
      return () => `run_${++counter}`;
    })(),
    onAccepted: (result) => accepted.push(result.runId),
  });
  db.immediate((tx) => {
    tx.prepare(
      "INSERT INTO workspaces (workspaceId, displayName, rootPath, perSessionQueueLimit, mobileApprovalMode, createdAt) VALUES ('ws_1','W','/tmp/ws_1',?, 'deny', 1)",
    ).run(options.queueLimit ?? 3);
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
  return { dir, db, sessions, runs, workspaces, journal, executor, admission, accepted };
}

function identity(overrides: Partial<CommandIdentity> = {}): CommandIdentity {
  return {
    commandId: 'cmd_1',
    type: 'prompt.send',
    workspaceId: 'ws_1',
    sessionId: 's1',
    payload: { text: 'S04_ADMISSION_PROMPT' },
    ...overrides,
  };
}

function send(
  context: ReturnType<typeof setup>,
  overrides: Partial<CommandIdentity> = {},
  text = 'S04_ADMISSION_PROMPT',
) {
  return context.admission.send({
    identity: identity(overrides),
    actor: { deviceId: 'device_1' },
    text,
    traceId: 'trace_1',
    now: NOW,
  });
}

describe('PromptAdmission', () => {
  it('persists a queued run and returns queued without starting a driver', () => {
    const context = setup();
    try {
      const execution = send(context);
      expect(execution.duplicate).toBe(false);
      expect(execution.result).toEqual({
        sessionId: 's1',
        runId: 'run_1',
        status: 'queued',
      });
      expect(execution.events).toHaveLength(1);
      expect(execution.events[0]).toMatchObject({
        type: 'run.queued',
        runId: 'run_1',
        payload: { enqueuedAt: NOW },
      });
      expect(context.accepted).toEqual(['run_1']);

      const run = context.runs.get('run_1');
      expect(run).toMatchObject({
        status: 'queued',
        promptText: 'S04_ADMISSION_PROMPT',
        promptExpiresAt: NOW + PROMPT_TTL_MS,
        recoveryGeneration: 0,
        outcomeUnknown: false,
      });
      expect(run?.enqueueOrder).toBe(1);

      const command = context.db.connection
        .prepare('SELECT resultJson FROM commands WHERE commandId = ?')
        .get('cmd_1') as { resultJson: string };
      expect(JSON.parse(command.resultJson)).toEqual(execution.result);
      expect(command.resultJson).not.toContain('S04_ADMISSION_PROMPT');
      expect(
        JSON.stringify(context.journal.recent('s1', 10)),
      ).not.toContain('S04_ADMISSION_PROMPT');
    } finally {
      context.db.close();
    }
  });

  it('keeps one run and one run.queued for a duplicate commandId', () => {
    const context = setup();
    try {
      const first = send(context);
      const second = send(context);
      expect(second.duplicate).toBe(true);
      expect(second.result).toEqual(first.result);
      expect(second.events).toEqual([]);
      expect(context.accepted).toEqual(['run_1']);
      expect(
        context.db.connection.prepare('SELECT count(*) AS total FROM runs').get(),
      ).toEqual({ total: 1 });
      expect(context.journal.recent('s1', 10)).toHaveLength(1);
    } finally {
      context.db.close();
    }
  });

  it('rejects empty, whitespace and oversized prompts without a run', () => {
    const context = setup();
    try {
      for (const text of ['', '   ', 'x'.repeat(16 * 1024 + 1)]) {
        expect(() => send(context, {}, text)).toThrow(/INVALID_MESSAGE/);
      }
      expect(
        context.db.connection.prepare('SELECT count(*) AS total FROM runs').get(),
      ).toEqual({ total: 0 });
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM commands')
          .get(),
      ).toEqual({ total: 0 });
    } finally {
      context.db.close();
    }
  });

  it('rejects archived sessions, unknown sessions and workspace mismatches', () => {
    const context = setup();
    try {
      expect(() => send(context, { sessionId: 'missing' })).toThrow(
        /SESSION_NOT_FOUND/,
      );
      expect(() => send(context, { workspaceId: 'ws_other' })).toThrow(
        /WORKSPACE_NOT_ALLOWED/,
      );
      context.db.immediate((tx) =>
        tx
          .prepare("UPDATE sessions SET lifecycle = 'archived' WHERE sessionId = 's1'")
          .run(),
      );
      expect(() => send(context)).toThrow(/SESSION_ARCHIVED/);
      expect(
        context.db.connection.prepare('SELECT count(*) AS total FROM runs').get(),
      ).toEqual({ total: 0 });
    } finally {
      context.db.close();
    }
  });

  it('enforces the per-session queue limit', () => {
    const context = setup({ queueLimit: 1 });
    try {
      send(context, { commandId: 'cmd_1' });
      expect(() =>
        send(context, { commandId: 'cmd_2', payload: { text: 'second' } }, 'second'),
      ).toThrow(/QUEUE_FULL/);
      expect(
        context.db.connection.prepare('SELECT count(*) AS total FROM runs').get(),
      ).toEqual({ total: 1 });
    } finally {
      context.db.close();
    }
  });

  it('rolls back run, event and command when event append fails', () => {
    const failing: EventAppender = {
      for: (_tx: SqliteTransaction): AppendEvent => () => {
        throw new Error('append failed');
      },
      publishCommitted: () => undefined,
    };
    const context = setup({ appender: failing });
    try {
      expect(() => send(context)).toThrow(/append failed/);
      expect(
        context.db.connection.prepare('SELECT count(*) AS total FROM runs').get(),
      ).toEqual({ total: 0 });
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM commands')
          .get(),
      ).toEqual({ total: 0 });
      expect(context.accepted).toEqual([]);
      expect(
        context.db.connection
          .prepare('SELECT value FROM scheduler_meta WHERE key = ?')
          .get('nextEnqueueOrder'),
      ).toBeUndefined();
    } finally {
      context.db.close();
    }
  });
});