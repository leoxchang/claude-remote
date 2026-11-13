import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentDatabase } from '../../src/storage/database.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { PersistentCommandExecutor } from '../../src/storage/persistent-command-executor.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { TimelineEvent } from '../../src/events/adapter-events.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 's04-publish-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const journal = new DurableEventJournal(db.uow);
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
      status: 'idle',
      lastSeq: 0,
      retentionFloor: 0,
      createdAt: 1,
      lastActivityAt: 1,
      archivedAt: null,
    });
  });
  return { db, journal };
}

describe('post-commit publication', () => {
  it('publishes only after commit, in seq order', () => {
    const context = fixture();
    const seen: TimelineEvent[] = [];
    try {
      context.journal.subscribe((event) => seen.push(event));
      const result = context.journal.commit((tx, append) => {
        append({ sessionId: 's1', type: 'run.queued', payload: { n: 1 } });
        expect(seen).toEqual([]);
        append({ sessionId: 's1', type: 'run.started', payload: { n: 2 } });
        expect(seen).toEqual([]);
        return 'value';
      });
      expect(result.value).toBe('value');
      expect(seen.map((event) => event.seq)).toEqual([1, 2]);
      expect(seen.map((event) => event.type)).toEqual([
        'run.queued',
        'run.started',
      ]);
    } finally {
      context.db.close();
    }
  });

  it('does not publish or persist anything when the transaction rolls back', () => {
    const context = fixture();
    const seen: TimelineEvent[] = [];
    try {
      context.journal.subscribe((event) => seen.push(event));
      expect(() =>
        context.journal.commit((tx, append) => {
          append({ sessionId: 's1', type: 'run.queued', payload: {} });
          throw new Error('rollback');
        }),
      ).toThrow(/rollback/);
      expect(seen).toEqual([]);
      expect(context.journal.recent('s1', 10)).toEqual([]);
      expect(context.journal.lastSeq('s1')).toBe(0);
    } finally {
      context.db.close();
    }
  });

  it('keeps events durable when a listener throws', () => {
    const context = fixture();
    const seen: TimelineEvent[] = [];
    try {
      context.journal.subscribe(() => {
        throw new Error('socket closed');
      });
      context.journal.subscribe((event) => seen.push(event));
      expect(() =>
        context.journal.commit((tx, append) =>
          append({ sessionId: 's1', type: 'run.queued', payload: {} }),
        ),
      ).not.toThrow();
      expect(seen).toHaveLength(1);
      expect(context.journal.recent('s1', 10)).toHaveLength(1);
    } finally {
      context.db.close();
    }
  });

  it('publishes once for a committed command and never on a duplicate', () => {
    const context = fixture();
    const seen: TimelineEvent[] = [];
    try {
      context.journal.subscribe((event) => seen.push(event));
      const executor = new PersistentCommandExecutor({
        uow: context.db.uow,
        appender: context.journal,
      });
      const identity = {
        commandId: 'cmd_1',
        type: 'prompt.send',
        sessionId: 's1',
        payload: { text: 'S04_SECRET_PROMPT' },
      };
      const first = executor.execute({
        identity,
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating' as const,
        now: 1,
        business: (tx, append) => {
          append({ sessionId: 's1', type: 'run.queued', payload: { n: 1 } });
          return { runId: 'run_1' };
        },
      });
      expect(first.duplicate).toBe(false);
      expect(seen).toHaveLength(1);

      const duplicate = executor.execute({
        identity,
        actor: { kind: 'device', deviceId: 'device_1' },
        kind: 'mutating' as const,
        now: 2,
        business: () => {
          throw new Error('must not run');
        },
      });
      expect(duplicate.duplicate).toBe(true);
      expect(seen).toHaveLength(1);
      expect(JSON.stringify(context.journal.recent('s1', 10))).not.toContain(
        'S04_SECRET_PROMPT',
      );
    } finally {
      context.db.close();
    }
  });
});