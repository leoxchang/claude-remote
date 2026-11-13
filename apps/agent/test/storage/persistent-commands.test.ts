import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CommandIdentity } from '../../src/command/canonical-request.js';
import { AgentDatabase } from '../../src/storage/database.js';
import {
  AppendEvent,
  EventAppender,
  PersistentCommandExecutor,
} from '../../src/storage/persistent-command-executor.js';
import { SqliteTransaction } from '../../src/storage/unit-of-work.js';
import { TimelineEvent } from '../../src/events/adapter-events.js';

class FakeAppender implements EventAppender {
  readonly appended: TimelineEvent[] = [];
  readonly published: TimelineEvent[] = [];
  private readonly seq = new Map<string, number>();

  for(_tx: SqliteTransaction): AppendEvent {
    return (input) => {
      const seq = (this.seq.get(input.sessionId) ?? 0) + 1;
      this.seq.set(input.sessionId, seq);
      const event: TimelineEvent = {
        protocolVersion: 1,
        messageId: `msg_${input.eventId ?? seq}`,
        timestamp: 1_762_432_800_000,
        type: input.type,
        payload: input.payload,
        eventId: input.eventId ?? `event_${seq}`,
        sessionId: input.sessionId,
        seq,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.approvalId === undefined
          ? {}
          : { approvalId: input.approvalId }),
      };
      this.appended.push(event);
      return event;
    };
  }

  publishCommitted(events: readonly TimelineEvent[]): void {
    this.published.push(...events);
  }
}

function identity(overrides: Partial<CommandIdentity> = {}): CommandIdentity {
  return {
    commandId: 'cmd_1',
    type: 'prompt.send',
    sessionId: 'session_1',
    payload: { text: 'S04_TEST_PROMPT' },
    ...overrides,
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 's04-commands-'));
  const path = join(dir, 'agent.sqlite3');
  const db = AgentDatabase.open(path);
  const appender = new FakeAppender();
  const executor = new PersistentCommandExecutor({
    uow: db.uow,
    appender,
  });
  db.immediate((tx) =>
    tx.exec('CREATE TABLE command_probe (id INTEGER PRIMARY KEY, value TEXT)'),
  );
  return { dir, path, db, appender, executor };
}

function business(counter: { runs: number }) {
  return (tx: SqliteTransaction, append: AppendEvent) => {
    counter.runs += 1;
    tx.prepare('INSERT INTO command_probe (value) VALUES (?)').run('probe');
    append({
      sessionId: 'session_1',
      type: 'run.queued',
      payload: { enqueuedAt: 1 },
      runId: 'run_1',
    });
    return { runId: 'run_1', status: 'queued' as const };
  };
}

describe('PersistentCommandExecutor', () => {
  it('runs business once per commandId and replays the persisted result', () => {
    const context = fixture();
    const counter = { runs: 0 };
    try {
      const first = context.executor.execute({
        identity: identity(),
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating',
        now: 1,
        business: business(counter),
      });
      expect(first.duplicate).toBe(false);
      expect(first.result).toEqual({ runId: 'run_1', status: 'queued' });
      expect(first.events).toHaveLength(1);

      const second = context.executor.execute({
        identity: identity(),
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating',
        now: 2,
        business: business(counter),
      });
      expect(second.duplicate).toBe(true);
      expect(second.result).toEqual(first.result);
      expect(second.events).toEqual([]);
      expect(counter.runs).toBe(1);
      expect(context.appender.published).toHaveLength(1);
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM command_probe')
          .get(),
      ).toEqual({ total: 1 });
    } finally {
      context.db.close();
    }
  });

  it('replays across reopen and returns a fresh result copy', () => {
    const context = fixture();
    const counter = { runs: 0 };
    const first = context.executor.execute({
      identity: identity(),
      actor: { kind: 'device', deviceId: 'device_1' },
      kind: 'mutating',
      now: 1,
      business: business(counter),
    });
    context.db.close();

    const reopened = AgentDatabase.open(context.path);
    try {
      const executor = new PersistentCommandExecutor({
        uow: reopened.uow,
        appender: new FakeAppender(),
      });
      const replay = executor.execute({
        identity: identity(),
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating',
        now: 2,
        business: () => {
          throw new Error('must not run');
        },
      });
      expect(replay.duplicate).toBe(true);
      expect(replay.result).toEqual(first.result);
      expect(replay.result).not.toBe(first.result);
    } finally {
      reopened.close();
    }
  });

  it('rejects a changed request for the same commandId', () => {
    const context = fixture();
    try {
      context.executor.execute({
        identity: identity(),
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating',
        now: 1,
        business: business({ runs: 0 }),
      });
      expect(() =>
        context.executor.execute({
          identity: identity({ payload: { text: 'different' } }),
          actor: { kind: 'device', deviceId: 'device_1' },
          kind: 'mutating',
          now: 2,
          business: business({ runs: 0 }),
        }),
      ).toThrow(/COMMAND_ID_CONFLICT/);
    } finally {
      context.db.close();
    }
  });

  it('rolls back business, events and result when business throws', () => {
    const context = fixture();
    try {
      expect(() =>
        context.executor.execute({
          identity: identity(),
          actor: { kind: 'device', deviceId: 'device_1' },
          kind: 'mutating',
          now: 1,
          business: (tx, append) => {
            tx.prepare('INSERT INTO command_probe (value) VALUES (?)').run('x');
            append({ sessionId: 'session_1', type: 'run.queued', payload: {} });
            throw new Error('business failed');
          },
        }),
      ).toThrow(/business failed/);
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM command_probe')
          .get(),
      ).toEqual({ total: 0 });
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM commands')
          .get(),
      ).toEqual({ total: 0 });
      expect(context.appender.published).toEqual([]);

      // 事务回滚后同一 commandId 可以重试并成功。
      const retried = context.executor.execute({
        identity: identity(),
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating',
        now: 2,
        business: business({ runs: 0 }),
      });
      expect(retried.duplicate).toBe(false);
    } finally {
      context.db.close();
    }
  });

  it('rejects async business functions without committing', () => {
    const context = fixture();
    try {
      expect(() =>
        context.executor.execute({
          identity: identity(),
          actor: { kind: 'local', actor: 'local_cli' },
          kind: 'mutating',
          now: 1,
          business: (async () => ({ ok: true })) as never,
        }),
      ).toThrow(/STORAGE_TRANSACTION_ASYNC/);
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM commands')
          .get(),
      ).toEqual({ total: 0 });
    } finally {
      context.db.close();
    }
  });

  it('stores actor and fingerprint but never the request payload', () => {
    const context = fixture();
    try {
      context.executor.execute({
        identity: identity(),
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating',
        now: 1,
        business: business({ runs: 0 }),
      });
      const row = context.db.connection
        .prepare('SELECT * FROM commands WHERE commandId = ?')
        .get('cmd_1') as Record<string, unknown>;
      expect(row['actorDeviceId']).toBe('device_1');
      expect(row['kind']).toBe('mutating');
      expect(JSON.stringify(row)).not.toContain('S04_TEST_PROMPT');
    } finally {
      context.db.close();
    }
  });
});