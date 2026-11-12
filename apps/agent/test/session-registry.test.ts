import { describe, expect, it } from 'vitest';

import { SessionRegistry } from '../src/session/session-registry.js';

function setup(ids: string[] = []): SessionRegistry {
  let index = 0;
  return new SessionRegistry({
    now: () => 1_762_432_800_000,
    generateId: () => ids[index++] ?? `session_${index}`,
  });
}

describe('SessionRegistry.create', () => {
  it('creates a local record without a Claude session or run', () => {
    const registry = setup();

    const record = registry.create({ workspaceId: 'ws_a' });

    expect(record).toMatchObject({
      workspaceId: 'ws_a',
      claudeSessionId: null,
      lifecycle: 'active',
      status: 'idle',
      activeRun: null,
      queue: [],
      lastRunStatus: null,
    });
    expect(record.runsById.size).toBe(0);
    expect(record.title).toMatch(/^会话 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('accepts an explicit title and validates it like a display name', () => {
    const registry = setup();

    expect(registry.create({ workspaceId: 'ws_a', title: '  Plan  ' }).title).toBe(
      'Plan',
    );
    expect(() =>
      registry.create({ workspaceId: 'ws_a', title: '🙂'.repeat(81) }),
    ).toThrow('INVALID_MESSAGE');
  });

  it('rejects an unknown session id', () => {
    const registry = setup();

    expect(() => registry.get('session_missing')).toThrow('SESSION_NOT_FOUND');
  });
});

describe('SessionRegistry.startCompatible', () => {
  it('creates when the workspace has no active session', () => {
    const registry = setup(['session_1']);

    const record = registry.startCompatible('ws_a');

    expect(record.sessionId).toBe('session_1');
  });

  it('attaches when exactly one active session exists', () => {
    const registry = setup(['session_1', 'session_2']);
    const first = registry.create({ workspaceId: 'ws_a' });

    expect(registry.startCompatible('ws_a').sessionId).toBe(first.sessionId);
  });

  it('refuses to guess when several active sessions exist', () => {
    const registry = setup(['session_1', 'session_2', 'session_3']);
    registry.create({ workspaceId: 'ws_a' });
    registry.create({ workspaceId: 'ws_a' });

    expect(() => registry.startCompatible('ws_a')).toThrow(
      'SESSION_SELECTION_REQUIRED',
    );
  });

  it('ignores archived sessions when deciding', () => {
    const registry = setup(['session_1', 'session_2']);
    const active = registry.create({ workspaceId: 'ws_a' });
    const archived = registry.create({ workspaceId: 'ws_a' });
    registry.archive(archived.sessionId);

    expect(registry.startCompatible('ws_a').sessionId).toBe(active.sessionId);
  });
});

describe('SessionRegistry.update and rename', () => {
  it('stores the reducer result without mutating the previous record', () => {
    const registry = setup(['session_1']);
    const before = registry.create({ workspaceId: 'ws_a' });

    const after = registry.update(before.sessionId, (current) => ({
      ...current,
      lastActivityAt: current.lastActivityAt + 1,
    }));

    expect(after).not.toBe(before);
    expect(before.lastActivityAt).toBe(1_762_432_800_000);
    expect(registry.get(before.sessionId).lastActivityAt).toBe(
      1_762_432_800_001,
    );
  });

  it('renames without touching the Claude mapping or runs', () => {
    const registry = setup(['session_1']);
    const record = registry.create({ workspaceId: 'ws_a' });

    const summary = registry.rename(record.sessionId, '  Renamed  ');

    expect(summary.title).toBe('Renamed');
    expect(registry.get(record.sessionId)).toMatchObject({
      sessionId: record.sessionId,
      claudeSessionId: null,
      lifecycle: 'active',
    });
  });
});

describe('SessionRegistry.archive', () => {
  it('refuses to archive while a run is active or queued', () => {
    const registry = setup(['session_1', 'session_2']);
    const busy = registry.create({ workspaceId: 'ws_a' });
    registry.update(busy.sessionId, (current) => ({
      ...current,
      activeRun: runRecord(current.sessionId),
    }));

    expect(() => registry.archive(busy.sessionId)).toThrow('SESSION_BUSY');

    const queued = registry.create({ workspaceId: 'ws_a' });
    registry.update(queued.sessionId, (current) => ({
      ...current,
      queue: [runRecord(current.sessionId)],
    }));
    expect(() => registry.archive(queued.sessionId)).toThrow('SESSION_BUSY');
  });

  it('archives once and is idempotent afterwards', () => {
    const registry = setup(['session_1']);
    const record = registry.create({ workspaceId: 'ws_a' });

    const archived = registry.archive(record.sessionId);
    const again = registry.archive(record.sessionId);

    expect(archived.status).toBe('archived');
    expect(again).toEqual(archived);
    expect(registry.get(record.sessionId).lifecycle).toBe('archived');
  });
});

describe('SessionRegistry.recordClaudeSession', () => {
  it('records the first Claude session id', () => {
    const registry = setup(['session_1']);
    const record = registry.create({ workspaceId: 'ws_a' });
    registry.update(record.sessionId, (current) => ({
      ...current,
      activeRun: runRecord(current.sessionId),
    }));

    registry.recordClaudeSession(record.sessionId, 'run_1', 'claude_1');

    expect(registry.get(record.sessionId).claudeSessionId).toBe('claude_1');
  });

  it('rejects rebinding to a different Claude session and fails the run', () => {
    const registry = setup(['session_1']);
    const record = registry.create({ workspaceId: 'ws_a' });
    registry.update(record.sessionId, (current) => {
      const run = runRecord(current.sessionId);
      return {
        ...current,
        activeRun: run,
        runsById: new Map([...current.runsById, [run.runId, run]]),
      };
    });
    registry.recordClaudeSession(record.sessionId, 'run_1', 'claude_1');

    expect(() =>
      registry.recordClaudeSession(record.sessionId, 'run_1', 'claude_2'),
    ).toThrow('INTERNAL_ERROR');

    const after = registry.get(record.sessionId);
    expect(after.claudeSessionId).toBe('claude_1');
    expect(after.runsById.get('run_1')?.status).toBe('failed');
  });
});

function runRecord(sessionId: string) {
  return {
    runId: 'run_1',
    sessionId,
    workspaceId: 'ws_a',
    commandId: 'cmd_1',
    traceId: 'trace_1',
    text: 'hello',
    status: 'running' as const,
    enqueueOrder: 1,
    enqueuedAt: 1_762_432_800_000,
    startedAt: 1_762_432_800_000,
    endedAt: null,
    errorSummary: null,
  };
}