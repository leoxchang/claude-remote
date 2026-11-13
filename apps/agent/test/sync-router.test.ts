import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableApprovalStore } from '../src/approval/durable-approval-store.js';
import { AgentOperations } from '../src/app/agent-operations.js';
import { CommandRouter } from '../src/command/router.js';
import { DeviceRecord } from '../src/domain/types.js';
import { DurableEventJournal } from '../src/events/durable-event-journal.js';
import { RecoveryService } from '../src/run/recovery-service.js';
import { SessionSyncService } from '../src/sync/session-sync-service.js';
import { SnapshotService } from '../src/sync/snapshot-service.js';
import { AgentDatabase } from '../src/storage/database.js';
import { PersistentCommandExecutor } from '../src/storage/persistent-command-executor.js';
import { RunRepository, StoredRun } from '../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../src/storage/repositories/session-repository.js';
import { SqliteWorkspaceRepository } from '../src/storage/repositories/workspace-repository.js';

const NOW = 1_762_432_800_000;
const DEVICE: DeviceRecord = {
  deviceId: 'device_1',
  deviceName: 'iPhone',
  tokenHash: 'hash',
  createdAt: '2026-11-12T00:00:00.000Z',
  revokedAt: null,
};

function command(type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: `msg_${type}`,
    timestamp: NOW,
    type,
    commandId: `cmd_${type}`,
    traceId: `trace_${type}`,
    sourceDeviceId: DEVICE.deviceId,
    sessionId: 's1',
    payload,
    ...extra,
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's04-router-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const sessions = new SessionRepository(db.uow);
  const runs = new RunRepository(db.uow);
  const workspaces = new SqliteWorkspaceRepository(db.uow);
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
  const recovery = new RecoveryService({ executor, runs, sessions, workspaces });
  const router = new CommandRouter({
    operations: {} as AgentOperations,
    sync,
    snapshots,
    recovery,
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
  });
  journal.commit((_tx, appendEvent) =>
    appendEvent({
      sessionId: 's1',
      type: 'message.completed',
      payload: { text: 'one' },
    }),
  );
  const recovering: StoredRun = {
    runId: 'run_recovering',
    sessionId: 's1',
    workspaceId: 'ws_1',
    deviceId: 'device_1',
    commandId: 'cmd_old',
    traceId: 'trace_old',
    status: 'recovery_required',
    promptText: 'prompt',
    promptExpiresAt: NOW + 1000,
    enqueueOrder: 1,
    recoveryGeneration: 1,
    pendingApprovalCount: 0,
    outcomeUnknown: false,
    eventTailMayBeIncomplete: false,
    recoveryReason: 'agent_shutdown',
    enqueuedAt: NOW,
    startedAt: null,
    endedAt: null,
    errorSummary: null,
  };
  runs.insert(recovering);
  return { db, journal, router, snapshots };
}

describe('S04 command routing', () => {
  it('maps session.sync pages and RESYNC_REQUIRED details', async () => {
    const context = setup();
    try {
      const page = await context.router.route(
        command('session.sync', { afterSeq: 0, limit: 100 }),
        DEVICE,
      );
      expect(page.payload).toMatchObject({
        status: 'ok',
        data: { nextAfterSeq: 1, lastSeq: 1, hasMore: false },
      });

      const resync = await context.router.route(
        command('session.sync', { afterSeq: 2, limit: 100 }, {
          commandId: 'cmd_resync',
        }),
        DEVICE,
      );
      expect(resync.payload).toMatchObject({
        status: 'error',
        error: { code: 'RESYNC_REQUIRED' },
      });
      const details = (resync.payload as unknown as {
        error: { details: { snapshot: { snapshotId: string } } };
      }).error.details;
      expect(Object.keys(details)).toEqual(['snapshot']);
      expect(details.snapshot.snapshotId).toEqual(expect.any(String));
    } finally {
      context.db.close();
    }
  });

  it('rejects invalid sync payloads before touching services', async () => {
    const context = setup();
    try {
      const invalid = await context.router.route(
        command('session.sync', { afterSeq: 0, limit: 101 }),
        DEVICE,
      );
      expect(invalid.payload).toMatchObject({
        status: 'error',
        error: { code: 'INVALID_MESSAGE' },
      });
    } finally {
      context.db.close();
    }
  });

  it('routes run.requeue and reports generation conflicts', async () => {
    const context = setup();
    try {
      const conflict = await context.router.route(
        command('run.requeue', { expectedRecoveryGeneration: 0 }, {
          runId: 'run_recovering',
        }),
        DEVICE,
      );
      expect(conflict.payload).toMatchObject({
        status: 'error',
        error: { code: 'RECOVERY_GENERATION_CONFLICT' },
      });

      const accepted = await context.router.route(
        command('run.requeue', { expectedRecoveryGeneration: 1 }, {
          commandId: 'cmd_requeue_ok',
          runId: 'run_recovering',
        }),
        DEVICE,
      );
      expect(accepted.payload).toMatchObject({
        status: 'ok',
        data: { runId: 'run_recovering', status: 'queued' },
      });
    } finally {
      context.db.close();
    }
  });
});