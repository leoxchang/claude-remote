import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableApprovalStore } from '../../src/approval/durable-approval-store.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import {
  MAX_SNAPSHOT_PAGES,
  SNAPSHOT_PAGE_PAYLOAD_BYTES,
  SnapshotService,
} from '../../src/sync/snapshot-service.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { PersistentCommandExecutor } from '../../src/storage/persistent-command-executor.js';
import { RunRepository, StoredRun } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';

const NOW = 1_762_432_800_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's04-snapshot-'));
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
  db.immediate((tx) => {
    tx.prepare(
      "INSERT INTO workspaces (workspaceId, displayName, rootPath, createdAt) VALUES ('ws_1','W','/tmp/ws_1',1)",
    ).run();
    sessions.create({
      sessionId: 's1',
      workspaceId: 'ws_1',
      claudeSessionId: 'claude_1',
      title: '项目会话',
      lifecycle: 'active',
      status: 'running',
      lastSeq: 0,
      retentionFloor: 0,
      createdAt: 1,
      lastActivityAt: 1,
      archivedAt: null,
    });
  });
  const run = (status: string, suffix: string): StoredRun => {
    const record: StoredRun = {
      runId: `run_${suffix}`,
      sessionId: 's1',
      workspaceId: 'ws_1',
      deviceId: 'device_1',
      commandId: `cmd_${suffix}`,
      traceId: `trace_${suffix}`,
      status,
      promptText: 'prompt',
      promptExpiresAt: NOW + 1000,
      enqueueOrder: 1,
      recoveryGeneration: status === 'recovery_required' ? 1 : 0,
      pendingApprovalCount: 0,
      outcomeUnknown: false,
      eventTailMayBeIncomplete: false,
      recoveryReason: status === 'recovery_required' ? 'agent_shutdown' : null,
      enqueuedAt: NOW,
      startedAt: null,
      endedAt: null,
      errorSummary: null,
    };
    runs.insert(record);
    return record;
  };
  run('running', 'active');
  run('queued', 'queued');
  run('recovery_required', 'recovery');
  return { db, sessions, runs, journal, snapshots, executor };
}

function appendLarge(context: ReturnType<typeof setup>, count: number): void {
  for (let index = 0; index < count; index += 1) {
    context.journal.commit((_tx, appendEvent) =>
      appendEvent({
        sessionId: 's1',
        type: 'message.completed',
        payload: { text: `${index}:${'中文'.repeat(2000)}` },
      }),
    );
  }
}

function getPage(
  context: ReturnType<typeof setup>,
  snapshotId?: string,
  pageIndex?: number,
  commandId = 'cmd_snapshot',
) {
  return context.snapshots.getPage({
    identity: {
      commandId,
      type: 'session.snapshot',
      sessionId: 's1',
      payload: {
        ...(snapshotId === undefined ? {} : { snapshotId }),
        ...(pageIndex === undefined ? {} : { pageIndex }),
      },
    },
    actor: { deviceId: 'device_1' },
    sessionId: 's1',
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(pageIndex === undefined ? {} : { pageIndex }),
    now: NOW,
  });
}

describe('SnapshotService', () => {
  it('builds bounded immutable pages that keep all safe state', () => {
    const context = setup();
    try {
      appendLarge(context, 12);
      const result = getPage(context).result;
      expect(result.pageCount).toBeLessThanOrEqual(MAX_SNAPSHOT_PAGES);
      expect(result.pageCount).toBeGreaterThan(1);
      const first = result.payload;
      expect(first['session']).toMatchObject({ title: '项目会话' });
      expect(first['activeRun']).toMatchObject({ runId: 'run_active' });
      expect(first['queuedRuns']).toHaveLength(1);
      expect(first['recoveryRequiredRuns']).toHaveLength(1);
      expect(first['recentEvents']).toBeInstanceOf(Array);

      for (let pageIndex = 0; pageIndex < result.pageCount; pageIndex += 1) {
        const page = getPage(
          context,
          result.snapshotId,
          pageIndex,
          `cmd_page_${pageIndex}`,
        ).result;
        expect(Buffer.byteLength(JSON.stringify(page.payload), 'utf8')).toBeLessThanOrEqual(
          SNAPSHOT_PAGE_PAYLOAD_BYTES,
        );
        expect(page.pageIndex).toBe(pageIndex);
        if (pageIndex > 0) {
          expect(page.payload['session']).toBeUndefined();
          expect(page.payload['recentEvents']).toBeInstanceOf(Array);
        }
      }
    } finally {
      context.db.close();
    }
  });

  it('returns SNAPSHOT_NOT_FOUND for unknown snapshots and pages', () => {
    const context = setup();
    try {
      appendLarge(context, 2);
      const created = getPage(context).result;
      expect(() =>
        getPage(context, 'snap_missing', 0, 'cmd_missing'),
      ).toThrow(/SNAPSHOT_NOT_FOUND/);
      expect(() =>
        getPage(context, created.snapshotId, created.pageCount, 'cmd_bad_page'),
      ).toThrow(/SNAPSHOT_NOT_FOUND/);
    } finally {
      context.db.close();
    }
  });

  it('produces the same canonical hash for identical content', () => {
    const context = setup();
    try {
      appendLarge(context, 3);
      const first = getPage(context, undefined, undefined, 'cmd_hash_1').result;
      const second = getPage(context, undefined, undefined, 'cmd_hash_2').result;
      expect(second.snapshotId).not.toBe(first.snapshotId);
      expect(second.sha256).toBe(first.sha256);
      expect(second.byteLength).toBe(first.byteLength);
      expect(second.lastSeq).toBe(first.lastSeq);
    } finally {
      context.db.close();
    }
  });
});