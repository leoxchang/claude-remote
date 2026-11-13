import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentDatabase } from '../../src/storage/database.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 's04-events-'));
  const path = join(dir, 'agent.sqlite3');
  const db = AgentDatabase.open(path);
  const sessions = new SessionRepository(db.uow);
  const journal = new DurableEventJournal(db.uow, {
    now: () => 1_762_432_800_000,
  });
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
    sessions.create({
      sessionId: 's2',
      workspaceId: 'ws_1',
      claudeSessionId: null,
      title: 'Two',
      lifecycle: 'active',
      status: 'idle',
      lastSeq: 0,
      retentionFloor: 0,
      createdAt: 1,
      lastActivityAt: 1,
      archivedAt: null,
    });
  });
  return { dir, path, db, sessions, journal };
}

describe('DurableEventJournal sequencing', () => {
  it('assigns independent per-session seq and advances sessions.lastSeq', () => {
    const context = fixture();
    try {
      const first = context.journal.commit((tx, append) => {
        append({ sessionId: 's1', type: 'run.queued', payload: { a: 1 } });
        append({ sessionId: 's1', type: 'run.started', payload: { a: 2 } });
        return append({ sessionId: 's2', type: 'run.queued', payload: { b: 1 } });
      });
      expect(first.events.map((event) => event.seq)).toEqual([1, 2, 1]);
      expect(context.journal.lastSeq('s1')).toBe(2);
      expect(context.journal.lastSeq('s2')).toBe(1);
      expect(context.sessions.get('s1')?.lastSeq).toBe(2);
      expect(context.sessions.get('s2')?.lastSeq).toBe(1);
    } finally {
      context.db.close();
    }
  });

  it('deduplicates identical eventId retransmits and rejects conflicts', () => {
    const context = fixture();
    try {
      const first = context.journal.commit((tx, append) =>
        append({
          sessionId: 's1',
          type: 'run.queued',
          payload: { a: 1 },
          eventId: 'event_fixed',
        }),
      ).value;
      const replay = context.journal.commit((tx, append) =>
        append({
          sessionId: 's1',
          type: 'run.queued',
          payload: { a: 1 },
          eventId: 'event_fixed',
        }),
      ).value;
      expect(replay).toEqual(first);

      expect(() =>
        context.journal.commit((tx, append) =>
          append({
            sessionId: 's1',
            type: 'run.queued',
            payload: { a: 2 },
            eventId: 'event_fixed',
          }),
        ),
      ).toThrow(/event id reused/);
      expect(context.journal.lastSeq('s1')).toBe(1);
    } finally {
      context.db.close();
    }
  });

  it('rolls back sequence and events with the transaction', () => {
    const context = fixture();
    try {
      expect(() =>
        context.journal.commit((tx, append) => {
          append({ sessionId: 's1', type: 'run.queued', payload: {} });
          throw new Error('boom');
        }),
      ).toThrow(/boom/);
      expect(context.journal.lastSeq('s1')).toBe(0);
      expect(context.journal.recent('s1', 10)).toEqual([]);
    } finally {
      context.db.close();
    }
  });

  it('replays recent and afterSeq pages after reopen', () => {
    const context = fixture();
    try {
      const event = context.journal.commit((tx, append) =>
        append({
          sessionId: 's1',
          type: 'run.queued',
          payload: { kept: true },
          eventId: 'event_1',
          runId: 'run_1',
        }),
      ).value;
      context.db.close();

      const reopened = AgentDatabase.open(context.path);
      try {
        const journal = new DurableEventJournal(reopened.uow);
        expect(journal.recent('s1', 10)).toEqual([event]);
        expect(journal.afterSeq('s1', 0, 100)).toEqual([event]);
        expect(journal.afterSeq('s1', 1, 100)).toEqual([]);
        expect(
          reopened.connection
            .prepare('SELECT payloadJson, type FROM events WHERE eventId = ?')
            .get('event_1'),
        ).toEqual({ payloadJson: JSON.stringify({ kept: true }), type: 'run.queued' });
      } finally {
        reopened.close();
      }
    } finally {
      // reopened 已关闭；原连接也需显式关闭。
      try {
        context.db.close();
      } catch {
        // 已关闭。
      }
    }
  });
});