import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CommandIdentity } from '../../src/command/canonical-request.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { CommandRepository } from '../../src/storage/repositories/command-repository.js';
import {
  AppendEvent,
  EventAppender,
  PersistentCommandExecutor,
} from '../../src/storage/persistent-command-executor.js';
import { SqliteTransaction } from '../../src/storage/unit-of-work.js';
import { TimelineEvent } from '../../src/events/adapter-events.js';

const DAY = 24 * 60 * 60 * 1000;
const START = 1_762_432_800_000;

const NO_EVENTS: EventAppender = {
  for: (_tx: SqliteTransaction): AppendEvent => (input) => {
    const event: TimelineEvent = {
      protocolVersion: 1,
      messageId: `msg_${input.eventId ?? '1'}`,
      timestamp: START,
      type: input.type,
      payload: input.payload,
      eventId: input.eventId ?? 'event_1',
      sessionId: input.sessionId,
      seq: 1,
    };
    return event;
  },
  publishCommitted: () => undefined,
};

function identity(overrides: Partial<CommandIdentity> = {}): CommandIdentity {
  return {
    commandId: 'cmd_read',
    type: 'session.sync',
    sessionId: 'session_1',
    payload: { afterSeq: 0, limit: 100 },
    ...overrides,
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 's04-expiry-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  return {
    db,
    executor: new PersistentCommandExecutor({ uow: db.uow, appender: NO_EVENTS }),
    commands: new CommandRepository(db.uow),
  };
}

function run(executor: PersistentCommandExecutor, now: number) {
  return executor.execute({
    identity: identity(),
    actor: { kind: 'device', deviceId: 'device_1' },
    kind: 'read_only',
    now,
    business: () => ({ events: [], nextAfterSeq: 0 }),
  });
}

describe('read-only command result retention', () => {
  it('returns the original page until the 7-day boundary', () => {
    const context = fixture();
    try {
      const first = run(context.executor, START);

      expect(context.commands.expireReadOnlyResults(START + 7 * DAY - 1)).toBe(0);
      const duplicate = run(context.executor, START + 7 * DAY - 1);
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.result).toEqual(first.result);
    } finally {
      context.db.close();
    }
  });

  it('expires the JSON but keeps a tombstone that returns COMMAND_RESULT_EXPIRED', () => {
    const context = fixture();
    try {
      run(context.executor, START);
      expect(context.commands.expireReadOnlyResults(START + 7 * DAY)).toBe(1);

      const row = context.db.connection
        .prepare('SELECT resultJson, resultExpired FROM commands WHERE commandId = ?')
        .get('cmd_read') as { resultJson: string | null; resultExpired: number };
      expect(row).toEqual({ resultJson: null, resultExpired: 1 });

      expect(() => run(context.executor, START + 7 * DAY + 1)).toThrow(
        /COMMAND_RESULT_EXPIRED/,
      );
      expect(() =>
        context.executor.execute({
          identity: identity({ payload: { afterSeq: 5, limit: 100 } }),
          actor: { kind: 'device', deviceId: 'device_1' },
          kind: 'read_only',
          now: START + 7 * DAY + 1,
          business: () => ({}),
        }),
      ).toThrow(/COMMAND_ID_CONFLICT/);
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM commands')
          .get(),
      ).toEqual({ total: 1 });
    } finally {
      context.db.close();
    }
  });

  it('never expires mutating results', () => {
    const context = fixture();
    try {
      const first = context.executor.execute({
        identity: identity({ commandId: 'cmd_mutate', type: 'prompt.send' }),
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating',
        now: START,
        business: () => ({ runId: 'run_1' }),
      });
      expect(context.commands.expireReadOnlyResults(START + 30 * DAY)).toBe(0);
      const duplicate = context.executor.execute({
        identity: identity({ commandId: 'cmd_mutate', type: 'prompt.send' }),
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating',
        now: START + 30 * DAY,
        business: () => {
          throw new Error('must not run');
        },
      });
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.result).toEqual(first.result);
    } finally {
      context.db.close();
    }
  });
});