import { describe, expect, it } from 'vitest';

import {
  PermissionResponseInput,
} from '../src/approval/approval-types.js';
import { DENIAL_MESSAGES } from '../src/approval/permission-broker.js';
import { makeRequest, setupBroker } from './approval-test-harness.js';

function allowInput(
  overrides: Partial<PermissionResponseInput> = {},
): PermissionResponseInput {
  return {
    approvalId: 'approval_1',
    workspaceId: 'ws_a',
    sessionId: 'session_run_1',
    runId: 'run_1',
    deviceId: 'device_1',
    commandId: 'cmd_allow',
    decision: 'allow_once',
    ...overrides,
  };
}

describe('PermissionBroker response and deadline races', () => {
  it('expires a response when the timer task has not run yet', async () => {
    const harness = setupBroker();
    const pending = harness.broker.request('run_1', makeRequest());
    harness.clock.advanceMonotonic(120_000);

    expect(() => harness.broker.respond(allowInput())).toThrow(
      'APPROVAL_EXPIRED',
    );
    expect(harness.store.getById('approval_1')?.status).toBe('expired');
    expect(harness.events.resolvedEvents).toHaveLength(1);
    expect(harness.events.resolvedEvents[0]).toMatchObject({
      status: 'expired',
      resolutionReason: 'timeout',
      responseCommandId: null,
    });
    await expect(pending).resolves.toMatchObject({
      behavior: 'deny',
      interrupt: false,
    });
    expect(harness.store.audit('approval_1')?.contentByteLength).not.toBeNull();
    expect(harness.store.audit('approval_1')?.contentSha256).not.toBeNull();
    expect(harness.timers.activeCount()).toBe(0);
  });

  it('lets an allow win at 119.999 seconds and never fires a second outcome', async () => {
    const harness = setupBroker();
    const pending = harness.broker.request('run_1', makeRequest());
    harness.clock.advanceMonotonic(119_999);

    const response = harness.broker.respond(allowInput());

    expect(response).toEqual({
      approvalId: 'approval_1',
      status: 'approved_once',
      resolvedAt: 1_762_432_800_000,
    });
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'echo S03_ALPHA', description: 'fixture' },
      toolUseID: 'toolu_1',
    });
    harness.timers.advance(10_000);
    expect(harness.events.resolvedEvents).toHaveLength(1);
    expect(harness.events.resolvedEvents[0]).toMatchObject({
      status: 'approved_once',
      resolutionReason: 'user_allow_once',
      responseCommandId: 'cmd_allow',
    });
    const record = harness.store.getById('approval_1');
    expect(record?.status).toBe('approved_once');
    expect(record?.content).toBeNull();
    expect(record?.originalInput).toBeNull();
    expect(record?.resultPromise).toBeNull();
  });

  it('records a user denial and resolves interrupt:false', async () => {
    const harness = setupBroker();
    const pending = harness.broker.request('run_1', makeRequest());

    const response = harness.broker.respond(
      allowInput({ commandId: 'cmd_deny', decision: 'deny' }),
    );

    expect(response.status).toBe('denied');
    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      message: DENIAL_MESSAGES.denied,
      interrupt: false,
      toolUseID: 'toolu_1',
    });
    expect(harness.store.getById('approval_1')?.resolutionReason).toBe(
      'user_deny',
    );
    expect(harness.events.resolvedEvents).toHaveLength(1);
    expect(harness.events.deniedEvents).toEqual([
      {
        sessionId: 'session_run_1',
        runId: 'run_1',
        toolUseID: 'toolu_1',
        toolName: 'Bash',
        outcome: 'denied',
      },
    ]);
  });

  it('rejects a response after the timeout task already fired', async () => {
    const harness = setupBroker();
    harness.broker.request('run_1', makeRequest());

    harness.timers.advance(120_000);

    expect(harness.store.getById('approval_1')?.status).toBe('expired');
    expect(() => harness.broker.respond(allowInput())).toThrow(
      'APPROVAL_EXPIRED',
    );
    expect(harness.events.resolvedEvents).toHaveLength(1);
  });

  it('ignores wall-clock jumps in both directions', async () => {
    const harness = setupBroker();
    const pending = harness.broker.request('run_1', makeRequest());
    harness.clock.advanceWall(24 * 60 * 60 * 1000);
    harness.clock.advanceMonotonic(1_000);

    harness.broker.respond(allowInput());

    await expect(pending).resolves.toMatchObject({
      behavior: 'allow',
    });
    harness.clock.advanceWall(-48 * 60 * 60 * 1000);
    harness.timers.advance(120_000);
    expect(harness.events.resolvedEvents).toHaveLength(1);
  });

  it('rejects wrong identifiers and unknown approvals', async () => {
    const harness = setupBroker();
    harness.broker.request('run_1', makeRequest());

    expect(() => harness.broker.respond(allowInput({ approvalId: 'missing' }))).toThrow(
      'APPROVAL_NOT_FOUND',
    );
    expect(() =>
      harness.broker.respond(allowInput({ workspaceId: 'ws_b' })),
    ).toThrow('APPROVAL_SESSION_MISMATCH');
    expect(() =>
      harness.broker.respond(allowInput({ sessionId: 'session_other' })),
    ).toThrow('APPROVAL_SESSION_MISMATCH');
    expect(() => harness.broker.respond(allowInput({ runId: 'run_other' }))).toThrow(
      'APPROVAL_SESSION_MISMATCH',
    );
    expect(() => harness.broker.respond(allowInput({ deviceId: 'device_2' }))).toThrow(
      'FORBIDDEN',
    );
    expect(harness.store.getById('approval_1')?.status).toBe('pending');
  });

  it('rejects a terminal approval and maps expiry distinctly', async () => {
    const harness = setupBroker();
    harness.broker.request('run_1', makeRequest());
    harness.broker.respond(allowInput({ decision: 'deny' }));

    expect(() => harness.broker.respond(allowInput())).toThrow(
      'APPROVAL_ALREADY_RESOLVED',
    );
    expect(harness.store.getById('approval_1')?.status).toBe('denied');
  });

  it('re-checks the current policy before allowing', async () => {
    const harness = setupBroker();
    const pending = harness.broker.request('run_1', makeRequest());
    harness.ports.mode = 'deny';

    expect(() => harness.broker.respond(allowInput())).toThrow(
      'APPROVAL_ALREADY_RESOLVED',
    );
    expect(harness.store.getById('approval_1')).toMatchObject({
      status: 'invalidated',
      resolutionReason: 'policy_disabled',
    });
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(harness.events.resolvedEvents).toHaveLength(1);
  });

  it('re-checks the current device before allowing', async () => {
    const harness = setupBroker();
    const pending = harness.broker.request('run_1', makeRequest());
    harness.ports.deviceIsActive = false;

    expect(() => harness.broker.respond(allowInput())).toThrow('FORBIDDEN');
    expect(harness.store.getById('approval_1')).toMatchObject({
      status: 'invalidated',
      resolutionReason: 'device_revoked',
    });
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });
});