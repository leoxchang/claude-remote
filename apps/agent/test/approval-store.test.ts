import { describe, expect, it } from 'vitest';

import { ApprovalStore } from '../src/approval/approval-store.js';
import {
  ApprovalContent,
  ApprovalRecord,
} from '../src/approval/approval-types.js';

const CONTENT: ApprovalContent = {
  encoding: 'json-utf8',
  jsonText: '{"toolName":"Bash"}',
  chunks: ['{"toolName":"Bash"}'],
  byteLength: 19,
  sha256: 'hash_01',
};

function record(
  overrides: Partial<ApprovalRecord> = {},
): ApprovalRecord {
  return {
    approvalId: 'approval_1',
    requestKey: 'run_1\u0000req_1',
    requestFingerprint: 'fingerprint_1',
    workspaceId: 'ws_a',
    sessionId: 'session_a',
    runId: 'run_1',
    deviceId: 'device_1',
    toolUseID: 'toolu_1',
    toolName: 'Bash',
    agentID: null,
    defaultToNo: false,
    hasDecisionReason: false,
    hasBlockedPath: false,
    status: 'pending',
    createdAt: 1_762_432_800_000,
    expiresAt: 1_762_432_920_000,
    resolvedAt: null,
    resolutionReason: null,
    responseCommandId: null,
    content: CONTENT,
    originalInput: { command: 'echo S03' },
    resultPromise: new Promise(() => undefined),
    ...overrides,
  };
}

describe('ApprovalStore', () => {
  it('indexes pending by id and request key and filters by owner', () => {
    const store = new ApprovalStore();
    store.registerPending(record());
    store.registerPending(
      record({
        approvalId: 'approval_2',
        requestKey: 'run_2\u0000req_2',
        runId: 'run_2',
        sessionId: 'session_b',
        workspaceId: 'ws_b',
        deviceId: 'device_2',
      }),
    );

    expect(store.getById('approval_1')?.approvalId).toBe('approval_1');
    expect(store.getByRequestKey('run_1\u0000req_1')?.approvalId).toBe(
      'approval_1',
    );
    expect(store.pendingForRun('run_1')).toHaveLength(1);
    expect(store.pendingForSession('session_b')).toHaveLength(1);
    expect(store.pendingForWorkspace('ws_a')).toHaveLength(1);
    expect(store.pendingForDevice('device_2')).toHaveLength(1);
    expect(store.pendingCount('run_1')).toBe(1);
    expect(store.globalPendingCount()).toBe(2);
    expect(store.getById('missing')).toBeNull();
  });

  it('removes only uncommitted pending records', () => {
    const store = new ApprovalStore();
    store.registerPending(record());

    store.removeUncommitted('approval_1');

    expect(store.getById('approval_1')).toBeNull();
    expect(store.getByRequestKey('run_1\u0000req_1')).toBeNull();
    expect(store.globalPendingCount()).toBe(0);
  });

  it('commits a terminal state once and keeps a safe audit', () => {
    const store = new ApprovalStore();
    store.registerPending(record());

    const committed = store.commitTerminal({
      approvalId: 'approval_1',
      status: 'approved_once',
      resolutionReason: 'user_allow_once',
      resolvedAt: 1_762_432_810_000,
      responseCommandId: 'cmd_1',
    });

    expect(committed?.previous.status).toBe('pending');
    expect(committed?.current).toMatchObject({
      status: 'approved_once',
      resolutionReason: 'user_allow_once',
      responseCommandId: 'cmd_1',
      content: null,
      originalInput: null,
      resultPromise: null,
    });
    expect(store.getById('approval_1')?.status).toBe('approved_once');
    expect(store.globalPendingCount()).toBe(0);

    const audit = store.audit('approval_1');
    expect(audit).toMatchObject({
      status: 'approved_once',
      contentByteLength: 19,
      contentSha256: 'hash_01',
      requestFingerprint: 'fingerprint_1',
    });
    expect(JSON.stringify(audit)).not.toContain('echo S03');

    expect(
      store.commitTerminal({
        approvalId: 'approval_1',
        status: 'denied',
        resolutionReason: 'user_deny',
        resolvedAt: 1_762_432_820_000,
        responseCommandId: null,
      }),
    ).toBeNull();
  });

  it('keeps request keys pointing at terminal records for reentry checks', () => {
    const store = new ApprovalStore();
    store.registerPending(record());
    store.commitTerminal({
      approvalId: 'approval_1',
      status: 'denied',
      resolutionReason: 'user_deny',
      resolvedAt: 1_762_432_810_000,
      responseCommandId: null,
    });

    expect(store.getByRequestKey('run_1\u0000req_1')?.status).toBe('denied');
    expect(store.pendingCount('run_1')).toBe(0);
  });
});