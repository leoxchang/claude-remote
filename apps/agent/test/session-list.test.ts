import { describe, expect, it } from 'vitest';

import { SessionRegistry } from '../src/session/session-registry.js';

const CREATED_AT = 1_762_432_800_000;

function setup(): SessionRegistry {
  let index = 0;
  return new SessionRegistry({
    now: () => CREATED_AT,
    generateId: () => {
      index += 1;
      return `session_${String(index).padStart(2, '0')}`;
    },
  });
}

describe('SessionRegistry.listSessions', () => {
  it('orders by createdAt then sessionId and paginates stably', () => {
    const registry = setup();
    registry.create({ workspaceId: 'ws_a' });
    registry.create({ workspaceId: 'ws_a' });
    registry.create({ workspaceId: 'ws_a' });

    const first = registry.listSessions({ workspaceId: 'ws_a', limit: 2 });
    expect(first.sessions.map((session) => session.sessionId)).toEqual([
      'session_03',
      'session_02',
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = registry.listSessions({
      workspaceId: 'ws_a',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.sessions.map((session) => session.sessionId)).toEqual([
      'session_01',
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('binds cursors to their workspace and includeArchived flag', () => {
    const registry = setup();
    registry.create({ workspaceId: 'ws_a' });
    registry.create({ workspaceId: 'ws_a' });
    const page = registry.listSessions({ workspaceId: 'ws_a', limit: 1 });

    expect(() =>
      registry.listSessions({
        workspaceId: 'ws_b',
        cursor: page.nextCursor ?? undefined,
      }),
    ).toThrow('INVALID_CURSOR');
    expect(() =>
      registry.listSessions({
        workspaceId: 'ws_a',
        includeArchived: true,
        cursor: page.nextCursor ?? undefined,
      }),
    ).toThrow('INVALID_CURSOR');
    expect(() =>
      registry.listSessions({ workspaceId: 'ws_a', cursor: 'tampered' }),
    ).toThrow('INVALID_CURSOR');
  });

  it('excludes archived sessions unless asked for them', () => {
    const registry = setup();
    const active = registry.create({ workspaceId: 'ws_a' });
    const archived = registry.create({ workspaceId: 'ws_a' });
    registry.archive(archived.sessionId);

    expect(
      registry.listSessions({ workspaceId: 'ws_a' }).sessions.map((s) => s.sessionId),
    ).toEqual([active.sessionId]);
    expect(
      registry
        .listSessions({ workspaceId: 'ws_a', includeArchived: true })
        .sessions.map((s) => s.sessionId),
    ).toHaveLength(2);
  });

  it('defaults to 20 and caps a request at 50', () => {
    const registry = setup();
    for (let index = 0; index < 60; index += 1) {
      registry.create({ workspaceId: 'ws_a' });
    }

    expect(registry.listSessions({ workspaceId: 'ws_a' }).sessions).toHaveLength(
      20,
    );
    expect(
      registry.listSessions({ workspaceId: 'ws_a', limit: 100 }).sessions,
    ).toHaveLength(50);
  });

  it('returns summaries without prompt or path fields', () => {
    const registry = setup();
    const record = registry.create({ workspaceId: 'ws_a' });
    registry.update(record.sessionId, (current) => ({
      ...current,
      queue: [runRecord(current.sessionId, 'run_queued')],
      activeRun: runRecord(current.sessionId, 'run_active'),
    }));

    const [summary] = registry.listSessions({ workspaceId: 'ws_a' }).sessions;

    expect(summary).toEqual({
      sessionId: record.sessionId,
      workspaceId: 'ws_a',
      title: record.title,
      claudeSessionId: null,
      status: 'running',
      activeRunId: 'run_active',
      queuedCount: 1,
      pendingApprovalCount: 0,
      createdAt: CREATED_AT,
      lastActivityAt: CREATED_AT,
      model: null,
    });
    expect(JSON.stringify(summary)).not.toContain('hello');
  });
});

function runRecord(sessionId: string, runId: string) {
  return {
    runId,
    sessionId,
    workspaceId: 'ws_a',
    deviceId: 'device_1',
    commandId: 'cmd_1',
    traceId: 'trace_1',
    text: 'hello',
    status: 'queued' as const,
    pendingApprovalCount: 0,
    enqueueOrder: 1,
    enqueuedAt: CREATED_AT,
    startedAt: null,
    endedAt: null,
    errorSummary: null,
  };
}