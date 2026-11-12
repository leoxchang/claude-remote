import { describe, expect, it, vi } from 'vitest';

import { RunRecord, SessionRecord } from '../src/domain/types.js';
import { EventJournal } from '../src/events/journal.js';
import { SnapshotCoordinator } from '../src/events/snapshot-coordinator.js';
import { SessionSnapshotEvent } from '../src/session/session-controller.js';

const SESSION: SessionRecord = {
  sessionId: 'session_01',
  workspaceId: 'default',
  title: '会话 2026-11-12 10:00',
  claudeSessionId: null,
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
  deviceId: 'device_1',
  commandId: 'cmd_01',
  traceId: 'trace_01',
  text: null,
  status: 'running',
  pendingApprovalCount: 0,
  enqueueOrder: 1,
  enqueuedAt: 1_762_432_800_000,
  startedAt: 1_762_432_800_000,
  endedAt: null,
  errorSummary: null,
};

function setup(): {
  journal: EventJournal;
  sent: SessionSnapshotEvent[];
  coordinator: SnapshotCoordinator;
} {
  const journal = new EventJournal();
  const sent: SessionSnapshotEvent[] = [];
  const coordinator = new SnapshotCoordinator({
    journal,
    getSession: () => SESSION,
    getActiveRun: () => RUN,
    send: (snapshot) => {
      sent.push(snapshot);
    },
  });
  return { journal, sent, coordinator };
}

describe('SnapshotCoordinator', () => {
  it('sends one snapshot and reports the captured last seq', async () => {
    const { journal, sent, coordinator } = setup();
    journal.append({
      sessionId: SESSION.sessionId,
      type: 'message.delta',
      payload: { assistantMessageId: 'msg_1', text: 'a' },
    });

    const result = await coordinator.captureAndSend(SESSION.sessionId, 1);

    expect(sent).toHaveLength(1);
    expect(result.lastSeq).toBe(1);
    expect(result.snapshot.type).toBe('session.snapshot');
    expect(sent[0]?.payload['lastSeq']).toBe(1);
  });

  it('places events appended afterwards after the snapshot', async () => {
    const { journal, sent, coordinator } = setup();
    journal.append({
      sessionId: SESSION.sessionId,
      type: 'message.delta',
      payload: { assistantMessageId: 'msg_1', text: 'a' },
    });

    await coordinator.captureAndSend(SESSION.sessionId, 1);
    const later = journal.append({
      sessionId: SESSION.sessionId,
      type: 'message.delta',
      payload: { assistantMessageId: 'msg_1', text: 'b' },
    });

    expect(later.seq).toBe(2);
    expect(sent[0]?.payload['lastSeq']).toBe(1);
    expect(
      (sent[0]?.payload['recentEvents'] as unknown[]).length,
    ).toBe(1);
  });

  it('does not include events appended during send', async () => {
    const journal = new EventJournal();
    const captured: Array<SessionSnapshotEvent> = [];
    const coordinator = new SnapshotCoordinator({
      journal,
      getSession: () => SESSION,
      getActiveRun: () => null,
      send: (snapshot) => {
        captured.push(snapshot);
        journal.append({
          sessionId: SESSION.sessionId,
          type: 'message.delta',
          payload: { assistantMessageId: 'msg_1', text: 'during' },
        });
      },
    });
    journal.append({
      sessionId: SESSION.sessionId,
      type: 'session.status',
      payload: { state: 'running' },
    });

    const result = await coordinator.captureAndSend(SESSION.sessionId, 2);

    expect(result.lastSeq).toBe(1);
    expect(captured[0]?.payload['lastSeq']).toBe(1);
    expect(journal.lastSeq(SESSION.sessionId)).toBe(2);
  });

  it('sends the snapshot before resolving the promise', async () => {
    const { sent, coordinator } = setup();
    const onSent = vi.fn();

    await coordinator.captureAndSend(SESSION.sessionId, 1).then(onSent);

    expect(sent).toHaveLength(1);
    expect(onSent).toHaveBeenCalledTimes(1);
  });
});