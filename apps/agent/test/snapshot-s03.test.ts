import { describe, expect, it } from 'vitest';

import {
  ApprovalContentDescriptor,
  ApprovalSummary,
} from '../src/approval/approval-types.js';
import { RunRecord, SessionRecord } from '../src/domain/types.js';
import { EventJournal } from '../src/events/journal.js';
import {
  SNAPSHOT_PAYLOAD_BUDGET,
  SnapshotFactory,
} from '../src/events/snapshot-factory.js';

const SESSION: SessionRecord = {
  sessionId: 'session_01',
  workspaceId: 'ws_01',
  title: 'Fixture Alpha',
  claudeSessionId: 'claude_01',
  lifecycle: 'active',
  status: 'waiting_approval',
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
  workspaceId: 'ws_01',
  deviceId: 'device_1',
  commandId: 'cmd_01',
  traceId: 'trace_01',
  text: null,
  status: 'waiting_approval',
  pendingApprovalCount: 8,
  enqueueOrder: 1,
  enqueuedAt: 1_762_432_800_000,
  startedAt: 1_762_432_800_000,
  endedAt: null,
  errorSummary: null,
};

const DESCRIPTOR: ApprovalContentDescriptor = {
  encoding: 'json-utf8',
  byteLength: 18342,
  sha256: 'hash_01',
  chunkCount: 1,
};

function summary(index: number): ApprovalSummary {
  return {
    approvalId: `approval_${index}`,
    workspaceId: 'ws_01',
    sessionId: 'session_01',
    runId: 'run_01',
    toolUseID: `toolu_${index}`,
    toolName: 'Bash',
    agentID: null,
    createdAt: 1_762_432_800_000,
    expiresAt: 1_762_432_920_000,
    defaultToNo: index === 0,
    hasDecisionReason: false,
    hasBlockedPath: false,
    content: { ...DESCRIPTOR, sha256: `hash_${index}` },
  };
}

interface SnapshotPayload {
  session: Record<string, unknown>;
  activeRun: Record<string, unknown> | null;
  pendingApprovals: Array<Record<string, unknown>>;
  recentEvents: Array<{ type: string; seq: number }>;
  snapshotTruncated: boolean;
}

describe('S03 snapshot integration', () => {
  it('keeps all eight pending summaries inside the message budget', () => {
    const journal = new EventJournal();
    for (let index = 0; index < 200; index += 1) {
      journal.append({
        sessionId: SESSION.sessionId,
        type: 'message.completed',
        payload: {
          assistantMessageId: `msg_${index}`,
          text: 'x'.repeat(8 * 1024),
          content: [],
          contentTruncated: false,
        },
        runId: RUN.runId,
      });
    }
    const pending = Array.from({ length: 8 }, (_unused, index) =>
      summary(index),
    );

    const snapshot = new SnapshotFactory().create({
      session: SESSION,
      activeRun: RUN,
      queuedRuns: [],
      journal,
      globalCapacity: { activeRunCount: 1, maxActiveRuns: 2 },
      pendingApprovals: pending,
    });

    const payloadBytes = Buffer.byteLength(
      JSON.stringify(snapshot.payload),
      'utf8',
    );
    const messageBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    const payload = snapshot.payload as unknown as SnapshotPayload;

    expect(payloadBytes).toBeLessThanOrEqual(SNAPSHOT_PAYLOAD_BUDGET);
    expect(messageBytes).toBeLessThanOrEqual(64 * 1024);
    expect(payload.pendingApprovals).toHaveLength(8);
    expect(payload.session['status']).toBe('waiting_approval');
    expect(payload.activeRun).toMatchObject({
      runId: 'run_01',
      status: 'waiting_approval',
      pendingApprovalCount: 8,
    });
    expect(payload.snapshotTruncated).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('workingDirectory');
    expect(payload.pendingApprovals[0]).toMatchObject({
      approvalId: 'approval_0',
      toolUseID: 'toolu_0',
      toolName: 'Bash',
      defaultToNo: true,
      content: { sha256: 'hash_0', chunkCount: 1 },
    });
  });

  it('omits pendingApprovals when there is no pending approval', () => {
    const snapshot = new SnapshotFactory().create({
      session: SESSION,
      activeRun: { ...RUN, status: 'running', pendingApprovalCount: 0 },
      queuedRuns: [],
      journal: new EventJournal(),
      globalCapacity: { activeRunCount: 1, maxActiveRuns: 2 },
    });

    const payload = snapshot.payload as unknown as SnapshotPayload;
    expect(payload.pendingApprovals).toEqual([]);
    expect(payload.session['status']).toBe('running');
  });
});