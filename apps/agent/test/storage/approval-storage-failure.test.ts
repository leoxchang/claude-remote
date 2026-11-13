import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableApprovalStore } from '../../src/approval/durable-approval-store.js';
import { DurablePermissionBroker } from '../../src/approval/durable-permission-broker.js';
import {
  ApprovalSafeError,
  SdkPermissionRequest,
} from '../../src/approval/approval-types.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { TimelineEvent } from '../../src/events/adapter-events.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { StorageHealth } from '../../src/storage/storage-health.js';
import { SqliteTransaction } from '../../src/storage/unit-of-work.js';
import { AppendEvent } from '../../src/storage/persistent-command-executor.js';

const NOW = 1_762_432_800_000;

/** 可切换失败的 journal；失败发生在任何写入之前。 */
class ToggleJournal {
  fail = false;
  constructor(
    private readonly inner: DurableEventJournal,
  ) {}

  commit<T>(
    fn: (tx: SqliteTransaction, append: AppendEvent) => T,
  ): { value: T; events: TimelineEvent[] } {
    if (this.fail) throw new Error('disk full');
    return this.inner.commit(fn);
  }

  publishCommitted(events: readonly TimelineEvent[]): void {
    this.inner.publishCommitted(events);
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's04-approval-failure-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const real = new DurableEventJournal(db.uow, { now: () => NOW });
  const journal = new ToggleJournal(real);
  const store = new DurableApprovalStore(
    db.uow,
    journal as unknown as DurableEventJournal,
  );
  const health = new StorageHealth();
  const errors: ApprovalSafeError[] = [];
  const sessions = new SessionRepository(db.uow);
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
      status: 'running',
      lastSeq: 0,
      retentionFloor: 0,
      createdAt: 1,
      lastActivityAt: 1,
      archivedAt: null,
    });
  });
  const broker = new DurablePermissionBroker({
    store,
    health,
    ports: {
      runContext: () => ({
        context: {
          workspaceId: 'ws_1',
          sessionId: 's1',
          runId: 'run_1',
          deviceId: 'device_1',
          workingDirectory: '/tmp/ws_1',
        },
        acceptingApprovals: true,
      }),
      workspaceMode: () => 'allow_once',
      deviceActive: () => true,
      setPendingApprovalCount: () => undefined,
    },
    events: {
      reportError: (error) => errors.push(error),
      toolDenied: () => undefined,
    },
    clock: { monotonicNow: () => 0, wallNow: () => NOW },
    timers: { schedule: () => () => undefined },
    generateApprovalId: () => 'approval_1',
  });
  return { db, store, health, errors, journal, broker };
}

function request(): SdkPermissionRequest {
  return {
    toolName: 'Bash',
    input: { command: 'echo S04_FAILURE' },
    signal: new AbortController().signal,
    toolUseID: 'toolu_1',
    requestId: 'request_1',
  };
}

const RESPOND = {
  approvalId: 'approval_1',
  workspaceId: 'ws_1',
  sessionId: 's1',
  runId: 'run_1',
  deviceId: 'device_1',
  commandId: 'cmd_1',
  decision: 'allow_once' as const,
};

describe('approval storage failure policy', () => {
  it('denies immediately and leaves no phantom pending when requested cannot commit', async () => {
    const context = setup();
    try {
      context.journal.fail = true;
      const result = await context.broker.request('run_1', request());
      expect(result).toMatchObject({ behavior: 'deny' });
      expect(context.store.volatile.size()).toBe(0);
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM approvals')
          .get(),
      ).toEqual({ total: 0 });
      expect(context.health.current().state).toBe('unavailable');
      expect(context.errors.map((error) => error.code)).toContain(
        'STORAGE_UNAVAILABLE',
      );
    } finally {
      context.db.close();
    }
  });

  it('never allows when the terminal commit fails, and denies the SDK promise', async () => {
    const context = setup();
    try {
      const pending = context.broker.request('run_1', request());
      context.journal.fail = true;
      expect(() => context.broker.respond(RESPOND)).toThrow(
        /STORAGE_UNAVAILABLE/,
      );
      expect(await pending).toMatchObject({ behavior: 'deny' });
      expect(context.store.volatile.size()).toBe(0);
      expect(context.health.current().state).toBe('unavailable');
      expect(context.store.getById('approval_1')?.status).toBe('pending');
      expect(
        context.db.connection
          .prepare("SELECT count(*) AS total FROM events WHERE type = 'permission.resolved'")
          .get(),
      ).toEqual({ total: 0 });

      // 降级后新的审批请求直接 deny，不再等待。
      const denied = await context.broker.request('run_1', {
        ...request(),
        requestId: 'request_2',
      });
      expect(denied).toMatchObject({ behavior: 'deny' });
    } finally {
      context.db.close();
    }
  });

  it('resolves deny and degrades when invalidation cannot commit', async () => {
    const context = setup();
    try {
      const pending = context.broker.request('run_1', request());
      context.journal.fail = true;
      expect(context.broker.invalidateRun('run_1', 'run_cancelled')).toBe(0);
      expect(await pending).toMatchObject({ behavior: 'deny' });
      expect(context.health.current().state).toBe('unavailable');
      expect(context.store.volatile.size()).toBe(0);
      // 未持久化的 resolved 不发送；下次启动修复仍会 invalidated。
      expect(
        context.db.connection
          .prepare("SELECT count(*) AS total FROM events WHERE type = 'permission.resolved'")
          .get(),
      ).toEqual({ total: 0 });
    } finally {
      context.db.close();
    }
  });
});