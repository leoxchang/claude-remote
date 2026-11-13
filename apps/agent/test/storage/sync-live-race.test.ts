import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableApprovalStore } from '../../src/approval/durable-approval-store.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { SessionSyncService } from '../../src/sync/session-sync-service.js';
import { SnapshotService } from '../../src/sync/snapshot-service.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { PersistentCommandExecutor } from '../../src/storage/persistent-command-executor.js';
import { RunRepository } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';

const NOW = 1_762_432_800_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's04-race-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const sessions = new SessionRepository(db.uow);
  const runs = new RunRepository(db.uow);
  const journal = new DurableEventJournal(db.uow, { now: () => NOW });
  const approvals = new DurableApprovalStore(db.uow, journal);
  const executor = new PersistentCommandExecutor({ uow: db.uow, appender: journal });
  const snapshots = new SnapshotService({
    executor,
    journal,
    sessions,
    runs,
    approvals,
    uow: db.uow,
    now: () => NOW,
  });
  const sync = new SessionSyncService({ executor, journal, snapshots, sessions, runs });
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
  const append = (text: string): void => {
    journal.commit((_tx, appendEvent) =>
      appendEvent({
        sessionId: 's1',
        type: 'message.completed',
        payload: { text },
      }),
    );
  };
  return { db, sessions, snapshots, sync, append };
}

describe('sync and snapshot live race', () => {
  it('keeps a captured sync page stable while live events append', () => {
    const context = setup();
    try {
      context.append('one');
      context.append('two');
      const first = context.sync.sync({
        identity: {
          commandId: 'cmd_sync',
          type: 'session.sync',
          sessionId: 's1',
          payload: { afterSeq: 0, limit: 100 },
        },
        actor: { deviceId: 'device_1' },
        sessionId: 's1',
        afterSeq: 0,
        limit: 100,
        now: NOW,
      }).result as {
        events: Array<{ seq: number }>;
        lastSeq: number;
        hasMore: boolean;
      };
      expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
      expect(first.lastSeq).toBe(2);

      context.append('live');

      const next = context.sync.sync({
        identity: {
          commandId: 'cmd_sync_2',
          type: 'session.sync',
          sessionId: 's1',
          payload: { afterSeq: 2, limit: 100 },
        },
        actor: { deviceId: 'device_1' },
        sessionId: 's1',
        afterSeq: 2,
        limit: 100,
        now: NOW,
      }).result as { events: Array<{ seq: number }>; lastSeq: number };
      expect(next.events.map((event) => event.seq)).toEqual([3]);
      expect(next.lastSeq).toBe(3);
    } finally {
      context.db.close();
    }
  });

  it('does not let an old snapshot include or overwrite newer events', () => {
    const context = setup();
    try {
      context.append('one');
      const snapshot = context.snapshots.getPage({
        identity: {
          commandId: 'cmd_snapshot',
          type: 'session.snapshot',
          sessionId: 's1',
          payload: {},
        },
        actor: { deviceId: 'device_1' },
        sessionId: 's1',
        now: NOW,
      }).result;
      expect(snapshot.lastSeq).toBe(1);

      context.append('two');
      const page = context.snapshots.getPage({
        identity: {
          commandId: 'cmd_snapshot_page',
          type: 'session.snapshot',
          sessionId: 's1',
          payload: { snapshotId: snapshot.snapshotId, pageIndex: 0 },
        },
        actor: { deviceId: 'device_1' },
        sessionId: 's1',
        snapshotId: snapshot.snapshotId,
        pageIndex: 0,
        now: NOW,
      }).result;
      expect(page.lastSeq).toBe(1);
      expect(JSON.stringify(page.payload)).not.toContain('two');
      expect(
        context.db.connection
          .prepare('SELECT lastSeq FROM sessions WHERE sessionId = ?')
          .get('s1'),
      ).toEqual({ lastSeq: 2 });
    } finally {
      context.db.close();
    }
  });

  it('replays the same read-only page even after live events arrive', () => {
    const context = setup();
    try {
      context.append('one');
      const first = context.sync.sync({
        identity: {
          commandId: 'cmd_repeat',
          type: 'session.sync',
          sessionId: 's1',
          payload: { afterSeq: 0, limit: 100 },
        },
        actor: { deviceId: 'device_1' },
        sessionId: 's1',
        afterSeq: 0,
        limit: 100,
        now: NOW,
      });
      context.append('two');
      const replay = context.sync.sync({
        identity: {
          commandId: 'cmd_repeat',
          type: 'session.sync',
          sessionId: 's1',
          payload: { afterSeq: 0, limit: 100 },
        },
        actor: { deviceId: 'device_1' },
        sessionId: 's1',
        afterSeq: 0,
        limit: 100,
        now: NOW,
      });
      expect(replay.duplicate).toBe(true);
      expect(replay.result).toEqual(first.result);
      expect(JSON.stringify(replay.result)).not.toContain('two');
    } finally {
      context.db.close();
    }
  });
});