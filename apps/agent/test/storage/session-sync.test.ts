import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { SessionSyncService } from '../../src/sync/session-sync-service.js';
import { SnapshotService } from '../../src/sync/snapshot-service.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { DurableApprovalStore } from '../../src/approval/durable-approval-store.js';
import { PersistentCommandExecutor } from '../../src/storage/persistent-command-executor.js';
import { RunRepository } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';

const NOW = 1_762_432_800_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's04-sync-'));
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
  const append = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      journal.commit((_tx, appendEvent) =>
        appendEvent({
          sessionId: 's1',
          type: 'message.completed',
          payload: { text: `消息 ${index}` },
        }),
      );
    }
  };
  return { db, sessions, runs, journal, sync, snapshots, append };
}

function runSync(
  context: ReturnType<typeof setup>,
  afterSeq: number,
  limit = 100,
  commandId = 'cmd_sync',
) {
  return context.sync.sync({
    identity: {
      commandId,
      type: 'session.sync',
      sessionId: 's1',
      payload: { afterSeq, limit },
    },
    actor: { deviceId: 'device_1' },
    sessionId: 's1',
    afterSeq,
    limit,
    now: NOW,
  });
}

describe('SessionSyncService', () => {
  it('returns ordered pages and only the last page carries volatile state', () => {
    const context = setup();
    try {
      context.append(5);
      const first = runSync(context, 0, 2);
      const page = first.result as {
        events: Array<{ seq: number }>;
        nextAfterSeq: number;
        lastSeq: number;
        hasMore: boolean;
        volatile: unknown;
      };
      expect(page.events.map((event) => event.seq)).toEqual([1, 2]);
      expect(page.nextAfterSeq).toBe(2);
      expect(page.lastSeq).toBe(5);
      expect(page.hasMore).toBe(true);
      expect(page.volatile).toBeNull();

      const last = runSync(context, 4, 2, 'cmd_sync_2').result as typeof page;
      expect(last.events.map((event) => event.seq)).toEqual([5]);
      expect(last.hasMore).toBe(false);
      expect(last.volatile).toMatchObject({ activeRunId: null });
    } finally {
      context.db.close();
    }
  });

  it('returns an empty page at L and a manifest-only resync beyond bounds', () => {
    const context = setup();
    try {
      context.append(3);
      const empty = runSync(context, 3).result as {
        events: unknown[];
        hasMore: boolean;
        nextAfterSeq: number;
      };
      expect(empty.events).toEqual([]);
      expect(empty.hasMore).toBe(false);
      expect(empty.nextAfterSeq).toBe(3);

      const resync = runSync(context, 4, 100, 'cmd_resync');
      expect(resync.result).toMatchObject({
        resyncRequired: true,
        manifest: { sessionId: 's1', lastSeq: 3 },
      });
      const manifest = (resync.result as { manifest: { snapshotId: string } })
        .manifest;
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM snapshot_pages WHERE snapshotId = ?')
          .get(manifest.snapshotId),
      ).toEqual({ total: 1 });
    } finally {
      context.db.close();
    }
  });

  it('requires resync below the retention floor and after a 1,000 gap', () => {
    const context = setup();
    try {
      context.append(2);
      context.db.immediate((tx) =>
        tx.prepare("UPDATE sessions SET retentionFloor = 2 WHERE sessionId = 's1'").run(),
      );
      expect(runSync(context, 1, 100, 'cmd_floor').result).toMatchObject({
        resyncRequired: true,
      });

      context.db.immediate((tx) => {
        tx.prepare(
          `INSERT INTO events (eventId, sessionId, seq, type, payloadJson, timestamp)
           VALUES ('event_jump', 's1', 1500, 'message.completed', '{}', 1)`,
        ).run();
        tx.prepare("UPDATE sessions SET lastSeq = 1500 WHERE sessionId = 's1'").run();
      });
      expect(runSync(context, 0, 100, 'cmd_gap').result).toMatchObject({
        resyncRequired: true,
      });
    } finally {
      context.db.close();
    }
  });

  it('rejects invalid limits before creating a command', () => {
    const context = setup();
    try {
      expect(() => runSync(context, 0, 0)).toThrow(/INVALID_MESSAGE/);
      expect(() => runSync(context, 0, 101)).toThrow(/INVALID_MESSAGE/);
      expect(
        context.db.connection.prepare('SELECT count(*) AS total FROM commands').get(),
      ).toEqual({ total: 0 });
    } finally {
      context.db.close();
    }
  });

  it('replays the same page for a duplicated read-only command', () => {
    const context = setup();
    try {
      context.append(3);
      const first = runSync(context, 0, 2, 'cmd_same');
      const second = runSync(context, 0, 2, 'cmd_same');
      expect(second.duplicate).toBe(true);
      expect(second.result).toEqual(first.result);
    } finally {
      context.db.close();
    }
  });
});