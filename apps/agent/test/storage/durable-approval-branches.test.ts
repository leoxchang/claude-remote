import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurableApprovalStore } from '../../src/approval/durable-approval-store.js';
import { DurablePermissionBroker } from '../../src/approval/durable-permission-broker.js';
import {
  ApprovalRuntimePorts,
  SdkPermissionRequest,
} from '../../src/approval/approval-types.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { StorageHealth } from '../../src/storage/storage-health.js';

const NOW = 1_762_432_800_000;

function setup(options: { workspaceMode?: 'deny' | 'allow_once'; active?: boolean; runContext?: boolean; input?: Record<string, unknown>; toolName?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 's04-broker-branches-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const journal = new DurableEventJournal(db.uow, { now: () => NOW });
  const store = new DurableApprovalStore(db.uow, journal);
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
  const errors: string[] = [];
  const ports: ApprovalRuntimePorts = {
    runContext: (runId) =>
      options.runContext === false
        ? null
        : {
            context: {
              workspaceId: 'ws_1',
              sessionId: 's1',
              runId,
              deviceId: 'device_1',
              workingDirectory: '/tmp/ws_1',
            },
            acceptingApprovals: true,
          },
    workspaceMode: () => options.workspaceMode ?? 'allow_once',
    deviceActive: () => options.active ?? true,
    setPendingApprovalCount: () => undefined,
  };
  let counter = 0;
  const broker = new DurablePermissionBroker({
    store,
    health: new StorageHealth(),
    ports,
    events: {
      reportError: (error) => errors.push(error.code),
      toolDenied: () => undefined,
    },
    clock: { monotonicNow: () => 0, wallNow: () => NOW },
    timers: { schedule: () => () => undefined },
    generateApprovalId: () => `approval_${++counter}`,
  });
  return { db, store, broker, errors };
}

function request(overrides: Partial<SdkPermissionRequest> = {}): SdkPermissionRequest {
  return {
    toolName: 'Bash',
    input: { command: 'echo ok' },
    signal: new AbortController().signal,
    toolUseID: 'toolu_1',
    requestId: 'request_1',
    ...overrides,
  };
}

describe('DurablePermissionBroker branches', () => {
  it('denies aborted, missing, non-accepting, disabled, revoked and unsupported requests', async () => {
    const aborted = setup();
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await aborted.broker.request('run_1', request({ signal: controller.signal }));
      expect(result).toMatchObject({ behavior: 'deny' });
      expect(aborted.store.globalPendingCount()).toBe(0);
    } finally {
      aborted.db.close();
    }

    for (const options of [
      { runContext: false },
      { workspaceMode: 'deny' as const },
      { active: false },
      { toolName: 'AskUserQuestion' },
    ]) {
      const context = setup(options);
      try {
        const result = await context.broker.request(
          'run_1',
          request({ toolName: options.toolName ?? 'Bash' }),
        );
        expect(result, JSON.stringify(options)).toMatchObject({ behavior: 'deny' });
        expect(context.store.globalPendingCount()).toBe(0);
      } finally {
        context.db.close();
      }
    }
  });

  it('rejects malformed or oversized content without pending rows', async () => {
    const malformedInput = JSON.parse(
      '{"command":"echo ok","__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const malformed = setup();
    try {
      expect(
        await malformed.broker.request(
          'run_1',
          request({ input: malformedInput }),
        ),
      ).toMatchObject({ behavior: 'deny' });
      expect(malformed.errors).toContain('APPROVAL_CONTENT_UNAVAILABLE');
    } finally {
      malformed.db.close();
    }

    const largeInput = { command: 'x'.repeat(1024 * 1024 + 1) };
    const large = setup();
    try {
      expect(
        await large.broker.request(
          'run_1',
          request({ input: largeInput }),
        ),
      ).toMatchObject({ behavior: 'deny' });
      expect(large.errors).toContain('APPROVAL_CONTENT_TOO_LARGE');
    } finally {
      large.db.close();
    }
  });

  it('handles respond validation and terminal reentry paths', async () => {
    const context = setup();
    try {
      const pending = context.broker.request('run_1', request());
      expect(() =>
        context.broker.respond({
          approvalId: 'missing',
          workspaceId: 'ws_1',
          sessionId: 's1',
          runId: 'run_1',
          deviceId: 'device_1',
          commandId: 'cmd',
          decision: 'deny',
        }),
      ).toThrow(/APPROVAL_NOT_FOUND/);
      expect(() =>
        context.broker.respond({
          approvalId: 'approval_1',
          workspaceId: 'wrong',
          sessionId: 's1',
          runId: 'run_1',
          deviceId: 'device_1',
          commandId: 'cmd',
          decision: 'deny',
        }),
      ).toThrow(/APPROVAL_SESSION_MISMATCH/);
      expect(() =>
        context.broker.respond({
          approvalId: 'approval_1',
          workspaceId: 'ws_1',
          sessionId: 's1',
          runId: 'run_1',
          deviceId: 'other',
          commandId: 'cmd',
          decision: 'deny',
        }),
      ).toThrow(/FORBIDDEN/);

      const denied = context.broker.respond({
        approvalId: 'approval_1',
        workspaceId: 'ws_1',
        sessionId: 's1',
        runId: 'run_1',
        deviceId: 'device_1',
        commandId: 'cmd_deny',
        decision: 'deny',
      });
      expect(denied.status).toBe('denied');
      expect(await pending).toMatchObject({ behavior: 'deny' });
      expect(() =>
        context.broker.respond({
          approvalId: 'approval_1',
          workspaceId: 'ws_1',
          sessionId: 's1',
          runId: 'run_1',
          deviceId: 'device_1',
          commandId: 'cmd_deny2',
          decision: 'deny',
        }),
      ).toThrow(/APPROVAL_ALREADY_RESOLVED/);

      const reentry = await context.broker.request('run_1', request());
      expect(reentry).toMatchObject({ behavior: 'deny' });
    } finally {
      context.db.close();
    }
  });

  it('invalidates by workspace, device and shutdown', async () => {
    const context = setup();
    try {
      const first = context.broker.request('run_1', request());
      expect(context.broker.invalidateWorkspace('ws_1', 'policy_disabled')).toBe(1);
      expect(await first).toMatchObject({ behavior: 'deny' });

      const second = context.broker.request('run_1', request({ requestId: 'r2' }));
      expect(context.broker.invalidateDevice('device_1', 'device_revoked')).toBe(1);
      expect(await second).toMatchObject({ behavior: 'deny' });

      const third = context.broker.request('run_1', request({ requestId: 'r3' }));
      expect(context.broker.invalidateAll('agent_shutdown')).toBe(1);
      expect(await third).toMatchObject({ behavior: 'deny' });
      expect(context.store.allPending()).toEqual([]);
    } finally {
      context.db.close();
    }
  });

  it('enforces per-run pending capacity', async () => {
    const context = setup();
    try {
      for (let index = 0; index < 8; index += 1) {
        void context.broker.request(
          'run_1',
          request({ requestId: `r${index}`, toolUseID: `t${index}` }),
        );
      }
      const ninth = await context.broker.request(
        'run_1',
        request({ requestId: 'r9', toolUseID: 't9' }),
      );
      expect(ninth).toMatchObject({ behavior: 'deny' });
      expect(context.errors).toContain('APPROVAL_CAPACITY_EXCEEDED');
    } finally {
      context.db.close();
    }
  });

  it('does not restore a pending allow when content is missing after restart', () => {
    const context = setup();
    try {
      void context.broker.request('run_1', request());
      const record = context.store.getById('approval_1');
      expect(record?.resultPromise).not.toBeNull();
      context.store.clearVolatile('approval_1');
      const reloaded = context.store.getById('approval_1');
      expect(reloaded?.originalInput).toBeNull();
      expect(reloaded?.resultPromise).toBeNull();
    } finally {
      context.db.close();
    }
  });

  it('settles an expired approval on direct access', () => {
    const context = setup();
    try {
      void context.broker.request('run_1', request());
      const settled = context.broker.settleIfExpired('approval_1');
      expect(settled).toBeNull();
    } finally {
      context.db.close();
    }
  });
});