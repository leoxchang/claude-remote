import { describe, expect, it } from 'vitest';

import { SessionRecord } from '../src/domain/types.js';
import { EventJournal } from '../src/events/journal.js';
import {
  QueuedRunSummary,
  SNAPSHOT_PAYLOAD_BUDGET,
  SnapshotFactory,
  SnapshotInput,
} from '../src/events/snapshot-factory.js';
import { computeSessionStatus } from '../src/session/session-summary.js';

const MAX_SNAPSHOT_MESSAGE_BYTES = 65_536;

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const base: SessionRecord = {
    sessionId: 'session_a',
    workspaceId: 'ws_alpha',
    title: '会话 2026-11-12 10:00',
    claudeSessionId: 'claude_a',
    lifecycle: 'active',
    status: 'idle',
    createdAt: 1_762_432_800_000,
    lastActivityAt: 1_762_432_800_000,
    activeRun: null,
    queue: [],
    runsById: new Map(),
    lastSeq: 0,
    lastRunStatus: null,
  };
  const merged = { ...base, ...overrides };
  return { ...merged, status: computeSessionStatus(merged) };
}

function queued(count: number): QueuedRunSummary[] {
  return Array.from({ length: count }, (_unused, index) => ({
    runId: `run_queued_${index}`,
    commandId: `cmd_queued_${index}`,
    status: 'queued' as const,
    enqueuedAt: 1_762_432_800_000 + index,
  }));
}

function input(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    session: session(),
    activeRun: null,
    queuedRuns: [],
    journal: new EventJournal(),
    globalCapacity: { activeRunCount: 0, maxActiveRuns: 2 },
    ...overrides,
  };
}

describe('SnapshotFactory S02 budget', () => {
  it('stays within budget with 20 queued runs, a long title and 200 large events', () => {
    const journal = new EventJournal();
    for (let index = 0; index < 200; index += 1) {
      journal.append({
        sessionId: 'session_a',
        type: 'tool.output',
        payload: {
          toolUseId: `tool_${index}`,
          chunk: 'x'.repeat(32 * 1024),
        },
      });
    }
    const snapshot = new SnapshotFactory().create(
      input({
        session: session({ title: '会'.repeat(80) }),
        journal,
        queuedRuns: queued(20),
        globalCapacity: { activeRunCount: 2, maxActiveRuns: 2 },
      }),
    );
    const payload = snapshot.payload as {
      queuedRuns: QueuedRunSummary[];
      globalCapacity: { activeRunCount: number; maxActiveRuns: number };
      session: { title: string; status: string };
      recentEvents: unknown[];
      snapshotTruncated: boolean;
    };

    expect(payload.queuedRuns).toHaveLength(20);
    expect(payload.globalCapacity).toEqual({
      activeRunCount: 2,
      maxActiveRuns: 2,
    });
    expect(payload.session.title).toBe('会'.repeat(80));
    expect(payload.recentEvents.length).toBeLessThanOrEqual(200);
    expect(payload.snapshotTruncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(snapshot.payload), 'utf8'),
    ).toBeLessThanOrEqual(SNAPSHOT_PAYLOAD_BUDGET);
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(
      MAX_SNAPSHOT_MESSAGE_BYTES,
    );
  });

  it('never copies prompt text into queued summaries', () => {
    const snapshot = new SnapshotFactory().create(
      input({ queuedRuns: queued(3) }),
    );
    const payload = snapshot.payload as { queuedRuns: QueuedRunSummary[] };

    expect(Object.keys(payload.queuedRuns[0] ?? {}).sort()).toEqual([
      'commandId',
      'enqueuedAt',
      'runId',
      'status',
    ]);
  });

  it('covers only the target session', () => {
    const journal = new EventJournal();
    journal.append({
      sessionId: 'session_a',
      type: 'message.delta',
      payload: { assistantMessageId: 'm1', text: 'target' },
    });
    journal.append({
      sessionId: 'session_b',
      type: 'message.delta',
      payload: { assistantMessageId: 'm2', text: 'other' },
    });

    const snapshot = new SnapshotFactory().create(input({ journal }));
    const payload = snapshot.payload as {
      recentEvents: Array<{ payload: Record<string, unknown> }>;
      lastSeq: number;
    };

    expect(payload.recentEvents).toHaveLength(1);
    expect(payload.recentEvents[0]?.payload['text']).toBe('target');
    expect(payload.lastSeq).toBe(1);
  });

  it('reports status, queued order and zero events', () => {
    const snapshot = new SnapshotFactory().create(
      input({ session: session({ title: 'Alpha' }), queuedRuns: queued(2) }),
    );
    const payload = snapshot.payload as {
      session: { status: string; title: string };
      queuedRuns: QueuedRunSummary[];
      recentEvents: unknown[];
      oldestIncludedSeq: number | null;
      snapshotTruncated: boolean;
    };

    expect(payload.session.status).toBe('queued');
    expect(payload.session.title).toBe('Alpha');
    expect(payload.queuedRuns.map((run) => run.runId)).toEqual([
      'run_queued_0',
      'run_queued_1',
    ]);
    expect(payload.recentEvents).toEqual([]);
    expect(payload.oldestIncludedSeq).toBeNull();
    expect(payload.snapshotTruncated).toBe(false);
  });

  it('marks truncated assistant text inside the budget', () => {
    const journal = new EventJournal();
    journal.append({
      sessionId: 'session_a',
      type: 'message.completed',
      payload: { assistantMessageId: 'm1', text: '会'.repeat(60_000) },
    });

    const snapshot = new SnapshotFactory().create(
      input({ journal, queuedRuns: queued(20) }),
    );
    const payload = snapshot.payload as {
      recentEvents: Array<{ payload: Record<string, unknown> }>;
    };

    expect(payload.recentEvents[0]?.payload['contentTruncated']).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(snapshot.payload), 'utf8'),
    ).toBeLessThanOrEqual(SNAPSHOT_PAYLOAD_BUDGET);
  });
});