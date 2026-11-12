import { describe, expect, it } from 'vitest';

import { RunRecord, SessionRecord } from '../src/domain/types.js';
import { EventJournal } from '../src/events/journal.js';
import { SnapshotFactory } from '../src/events/snapshot-factory.js';

const SESSION: SessionRecord = {
  sessionId: 'session_01',
  workspaceId: 'default',
  title: '会话 2026-11-12 10:00',
  claudeSessionId: 'claude_01',
  lifecycle: 'active',
  status: 'running',
  createdAt: 1_762_432_800_000,
  lastActivityAt: 1_762_432_800_000,
  activeRun: null,
  queue: [],
  runsById: new Map(),
  lastSeq: 0,
  lastRunStatus: null,
};

const RUN: RunRecord = {
  runId: 'run_01',
  sessionId: 'session_01',
  workspaceId: 'default',
  commandId: 'cmd_01',
  traceId: 'trace_01',
  text: null,
  status: 'running',
  enqueueOrder: 1,
  enqueuedAt: 1_762_432_800_000,
  startedAt: 1_762_432_800_000,
  endedAt: null,
  errorSummary: null,
};

interface SnapshotPayload {
  session: Record<string, unknown>;
  activeRun: Record<string, unknown> | null;
  lastRunStatus: string | null;
  recentEvents: Array<{ type: string; seq: number; payload: Record<string, unknown> }>;
  lastSeq: number;
  oldestIncludedSeq: number | null;
  snapshotTruncated: boolean;
}

function create(journal: EventJournal, activeRun: RunRecord | null = RUN): SnapshotPayload {
  const snapshot = new SnapshotFactory().create({
    session: SESSION,
    activeRun,
    queuedRuns: [],
    journal,
    globalCapacity: {
      activeRunCount: activeRun === null ? 0 : 1,
      maxActiveRuns: 2,
    },
  });
  return snapshot.payload as unknown as SnapshotPayload;
}

function toolOutput(journal: EventJournal, toolUseId: string, text: string): void {
  journal.append({
    sessionId: SESSION.sessionId,
    type: 'tool.output',
    payload: { toolUseId, chunk: text, chunkSeq: 1, truncated: false },
    runId: RUN.runId,
  });
}

describe('SnapshotFactory', () => {
  it('keeps the snapshot within the payload and message budgets', () => {
    const journal = new EventJournal();
    for (let index = 0; index < 200; index += 1) {
      toolOutput(journal, `toolu_${index}`, 'x'.repeat(32 * 1024));
    }

    const snapshot = new SnapshotFactory().create({
      session: SESSION,
      activeRun: RUN,
      queuedRuns: [],
      journal,
      globalCapacity: { activeRunCount: 1, maxActiveRuns: 2 },
    });
    const payload = snapshot.payload as unknown as SnapshotPayload;

    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(
      48 * 1024,
    );
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(64 * 1024);
    expect(payload.recentEvents.length).toBeLessThanOrEqual(200);
    expect(payload.snapshotTruncated).toBe(true);
    expect(payload.lastSeq).toBe(journal.lastSeq(SESSION.sessionId));
  });

  it('reports the oldest included seq and an empty snapshot', () => {
    const journal = new EventJournal();
    const empty = create(journal);
    expect(empty.recentEvents).toEqual([]);
    expect(empty.oldestIncludedSeq).toBeNull();
    expect(empty.lastSeq).toBe(0);

    journal.append({
      sessionId: SESSION.sessionId,
      type: 'session.status',
      payload: { state: 'running' },
    });
    journal.append({
      sessionId: SESSION.sessionId,
      type: 'run.completed',
      payload: { status: 'succeeded' },
    });

    const snapshot = create(journal);
    expect(snapshot.oldestIncludedSeq).toBe(1);
    expect(snapshot.lastSeq).toBe(2);
    expect(snapshot.snapshotTruncated).toBe(false);
  });

  it('omits deltas that precede a completed message', () => {
    const journal = new EventJournal();
    journal.append({
      sessionId: SESSION.sessionId,
      type: 'message.delta',
      payload: { assistantMessageId: 'msg_1', text: 'partial' },
    });
    journal.append({
      sessionId: SESSION.sessionId,
      type: 'message.completed',
      payload: { assistantMessageId: 'msg_1', text: 'final' },
    });

    const snapshot = create(journal);

    expect(snapshot.recentEvents.map((event) => event.type)).toEqual([
      'message.completed',
    ]);
    expect(snapshot.snapshotTruncated).toBe(true);
  });

  it('keeps only the newest tool output per toolUseId and truncates it', () => {
    const journal = new EventJournal();
    toolOutput(journal, 'toolu_1', 'old');
    toolOutput(journal, 'toolu_1', 'y'.repeat(8 * 1024));

    const snapshot = create(journal);

    const outputs = snapshot.recentEvents.filter(
      (event) => event.type === 'tool.output',
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.payload['truncated']).toBe(true);
    expect(
      Buffer.byteLength(String(outputs[0]?.payload['chunk']), 'utf8'),
    ).toBeLessThanOrEqual(4 * 1024);
    expect(snapshot.snapshotTruncated).toBe(true);
  });

  it('omits tool input in the snapshot', () => {
    const journal = new EventJournal();
    journal.append({
      sessionId: SESSION.sessionId,
      type: 'tool.started',
      payload: { toolUseId: 'toolu_1', toolName: 'Read', input: { path: 'a.ts' } },
    });

    const snapshot = create(journal);

    expect(snapshot.recentEvents[0]?.payload).toMatchObject({
      toolUseId: 'toolu_1',
      toolName: 'Read',
      input: {},
      inputOmittedInSnapshot: true,
    });
  });

  it('keeps at most 8 KiB of the active delta per message', () => {
    const journal = new EventJournal();
    for (let index = 0; index < 4; index += 1) {
      journal.append({
        sessionId: SESSION.sessionId,
        type: 'message.delta',
        payload: {
          assistantMessageId: 'msg_live',
          text: 'z'.repeat(4 * 1024),
          deltaSeq: index,
        },
      });
    }

    const snapshot = create(journal);
    const deltas = snapshot.recentEvents.filter(
      (event) => event.type === 'message.delta',
    );
    const bytes = deltas.reduce(
      (total, event) => total + Buffer.byteLength(String(event.payload['text']), 'utf8'),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(8 * 1024);
    expect(snapshot.snapshotTruncated).toBe(true);
  });

  it('reports the last run status when no run is active', () => {
    const journal = new EventJournal();
    journal.append({
      sessionId: SESSION.sessionId,
      type: 'run.completed',
      payload: { status: 'succeeded' },
    });

    const snapshot = create(journal, null);

    expect(snapshot.activeRun).toBeNull();
    expect(snapshot.lastRunStatus).toBe('succeeded');
    expect(snapshot.session).toMatchObject({
      sessionId: 'session_01',
      claudeSessionId: 'claude_01',
      workspaceId: 'default',
    });
  });
});
describe('SnapshotFactory empty state', () => {
  it('reports no last run status without an active run', () => {
    const journal = new EventJournal();

    const snapshot = create(journal, null);

    expect(snapshot.lastRunStatus).toBeNull();
    expect(snapshot.snapshotTruncated).toBe(false);
  });
});
