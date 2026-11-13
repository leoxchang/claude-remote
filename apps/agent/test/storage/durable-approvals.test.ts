import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableApprovalStore } from '../../src/approval/durable-approval-store.js';
import { DurablePermissionBroker } from '../../src/approval/durable-permission-broker.js';
import {
  ApprovalRuntimePorts,
  ApprovalSafeError,
  PermissionResult,
  SdkPermissionRequest,
  ToolDeniedNotice,
} from '../../src/approval/approval-types.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { StorageHealth } from '../../src/storage/storage-health.js';

const NOW = 1_762_432_800_000;

interface HarnessState {
  errors: ApprovalSafeError[];
  denied: ToolDeniedNotice[];
  pendingCounts: Array<{ runId: string; count: number }>;
  health: StorageHealth;
  wall: number;
  monotonic: number;
  timers: Array<() => void>;
}

function setup(existing?: { dir: string; path: string }) {
  const dir = existing?.dir ?? mkdtempSync(join(tmpdir(), 's04-approvals-'));
  const path = existing?.path ?? join(dir, 'agent.sqlite3');
  const db = AgentDatabase.open(path);
  const journal = new DurableEventJournal(db.uow, { now: () => NOW });
  const store = new DurableApprovalStore(db.uow, journal);
  const sessions = new SessionRepository(db.uow);
  db.immediate((tx) => {
    tx.prepare(
      "INSERT OR IGNORE INTO workspaces (workspaceId, displayName, rootPath, createdAt) VALUES ('ws_1','W','/tmp/ws_1',1)",
    ).run();
    if (sessions.get('s1') === undefined) {
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
    }
  });
  const harness: HarnessState = {
    errors: [],
    denied: [],
    pendingCounts: [],
    health: new StorageHealth(),
    wall: NOW,
    monotonic: 0,
    timers: [],
  };
  const ports: ApprovalRuntimePorts & { counts: Array<[string, number]> } = {
    counts: [],
    runContext: (runId) =>
      runId === 'run_1'
        ? {
            context: {
              workspaceId: 'ws_1',
              sessionId: 's1',
              runId: 'run_1',
              deviceId: 'device_1',
              workingDirectory: '/tmp/ws_1',
            },
            acceptingApprovals: true,
          }
        : null,
    workspaceMode: () => 'allow_once',
    deviceActive: (deviceId) => deviceId === 'device_1',
    setPendingApprovalCount: (runId, count) => {
      ports.counts.push([runId, count]);
      harness.pendingCounts.push({ runId, count });
    },
  };
  const clock = {
    monotonicNow: () => harness.monotonic,
    wallNow: () => harness.wall,
  };
  const timers = {
    schedule: (callback: () => void) => {
      harness.timers.push(callback);
      return () => undefined;
    },
  };
  let approvalCounter = 0;
  const broker = new DurablePermissionBroker({
    store,
    health: harness.health,
    ports,
    events: {
      reportError: (error: ApprovalSafeError) => harness.errors.push(error),
      toolDenied: (notice) => harness.denied.push(notice),
    },
    clock,
    timers,
    generateApprovalId: () => `approval_${++approvalCounter}`,
  });
  return { dir, path, db, store, broker, harness };
}

function request(overrides: Partial<SdkPermissionRequest> = {}): SdkPermissionRequest {
  return {
    toolName: 'Bash',
    input: { command: 'echo S04_APPROVAL' },
    signal: new AbortController().signal,
    toolUseID: 'toolu_1',
    requestId: 'request_1',
    ...overrides,
  };
}

describe('DurablePermissionBroker', () => {
  it('persists only safe approval metadata and publishes requested after commit', async () => {
    const context = setup();
    try {
      const promise = context.broker.request('run_1', request());
      const row = context.db.connection
        .prepare('SELECT * FROM approvals WHERE approvalId = ?')
        .get('approval_1') as Record<string, unknown>;
      expect(row['status']).toBe('pending');
      expect(row['toolName']).toBe('Bash');
      expect(row['contentSha256']).toEqual(expect.any(String));
      expect(row['contentByteLength']).toEqual(expect.any(Number));
      for (const forbidden of ['originalInput', 'content', 'resultPromise', 'jsonText']) {
        expect(row).not.toHaveProperty(forbidden);
      }
      expect(JSON.stringify(row)).not.toContain('S04_APPROVAL');

      const record = context.store.getById('approval_1');
      expect(record?.content?.jsonText).toContain('S04_APPROVAL');
      expect(record?.originalInput).toEqual({ command: 'echo S04_APPROVAL' });

      const requested = context.db.connection
        .prepare("SELECT payloadJson FROM events WHERE type = 'permission.requested'")
        .get() as { payloadJson: string };
      expect(requested.payloadJson).not.toContain('S04_APPROVAL');

      const result = context.harness.timers.length;
      expect(result).toBe(1);
      // allow once，释放 pending。
      context.harness.monotonic = 1000;
      context.harness.wall = NOW + 1000;
      context.broker.respond({
        approvalId: 'approval_1',
        workspaceId: 'ws_1',
        sessionId: 's1',
        runId: 'run_1',
        deviceId: 'device_1',
        commandId: 'cmd_1',
        decision: 'allow_once',
      });
      const allowed = (await promise) as Extract<PermissionResult, { behavior: 'allow' }>;
      expect(allowed.behavior).toBe('allow');
      expect(allowed.updatedInput).toEqual({ command: 'echo S04_APPROVAL' });
      expect(context.store.volatile.size()).toBe(0);
      expect(context.store.getById('approval_1')?.content).toBeNull();
    } finally {
      context.db.close();
    }
  });

  it('keeps Promise identity for a duplicate pending request', async () => {
    const context = setup();
    try {
      const first = context.broker.request('run_1', request());
      const second = context.broker.request('run_1', request());
      expect(second).toBe(first);
      expect(
        context.db.connection.prepare('SELECT count(*) AS total FROM approvals').get(),
      ).toEqual({ total: 1 });
      const resolved = context.db.connection
        .prepare("SELECT count(*) AS total FROM events WHERE type = 'permission.resolved'")
        .get();
      expect(resolved).toEqual({ total: 0 });
    } finally {
      context.db.close();
    }
  });

  it('denies a completed allow reentry without a second resolved event', async () => {
    const context = setup();
    try {
      const first = context.broker.request('run_1', request());
      context.broker.respond({
        approvalId: 'approval_1',
        workspaceId: 'ws_1',
        sessionId: 's1',
        runId: 'run_1',
        deviceId: 'device_1',
        commandId: 'cmd_1',
        decision: 'allow_once',
      });
      await first;
      const reentry = await context.broker.request('run_1', request());
      expect(reentry).toMatchObject({ behavior: 'deny' });
      expect(
        context.db.connection
          .prepare("SELECT count(*) AS total FROM events WHERE type = 'permission.resolved'")
          .get(),
      ).toEqual({ total: 1 });
      expect(context.harness.errors.map((error) => error.code)).toContain(
        'APPROVAL_DUPLICATE_AFTER_RESOLUTION',
      );
    } finally {
      context.db.close();
    }
  });

  it('never restores pending content after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 's04-approvals-'));
    const path = join(dir, 'agent.sqlite3');
    const first = setup({ dir, path });
    first.broker.request('run_1', request());
    first.db.close();

    const second = setup({ dir, path });
    try {
      const record = second.store.getById('approval_1');
      expect(record?.status).toBe('pending');
      expect(record?.content).toBeNull();
      expect(record?.originalInput).toBeNull();
      expect(record?.resultPromise).toBeNull();
      expect(second.store.volatile.size()).toBe(0);
    } finally {
      second.db.close();
    }
  });

  it('expires at the monotonic deadline and resolves deny', async () => {
    const context = setup();
    try {
      const promise = context.broker.request('run_1', request());
      context.harness.monotonic = 120_000;
      context.harness.wall = NOW + 120_000;
      context.harness.timers[0]?.();
      const result = await promise;
      expect(result).toMatchObject({ behavior: 'deny' });
      const record = context.store.getById('approval_1');
      expect(record?.status).toBe('expired');
      expect(
        context.db.connection
          .prepare("SELECT count(*) AS total FROM events WHERE type = 'permission.resolved'")
          .get(),
      ).toEqual({ total: 1 });
    } finally {
      context.db.close();
    }
  });

  it('invalidates pending approvals by run and resolves deny', async () => {
    const context = setup();
    try {
      const promise = context.broker.request('run_1', request());
      expect(context.broker.invalidateRun('run_1', 'run_cancelled')).toBe(1);
      expect(await promise).toMatchObject({ behavior: 'deny' });
      expect(context.store.getById('approval_1')?.status).toBe('invalidated');
      expect(context.harness.denied).toHaveLength(1);
    } finally {
      context.db.close();
    }
  });
});