import { describe, expect, it } from 'vitest';

import { PermissionResponseInput } from '../src/approval/approval-types.js';
import { DENIAL_MESSAGES } from '../src/approval/permission-broker.js';
import {
  BrokerHarness,
  makeRequest,
  setupBroker,
} from './approval-test-harness.js';

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

function moveRunTo(harness: BrokerHarness, runId: string, workspaceId: string, deviceId: string): void {
  const context = harness.ports.contexts.get(runId);
  if (context === undefined) return;
  harness.ports.contexts.set(runId, {
    ...context,
    workspaceId,
    deviceId,
  });
}

describe('PermissionBroker completed-allow reentry', () => {
  it('denies a completed allow callback instead of replaying it', async () => {
    const harness = setupBroker();
    const first = harness.broker.request('run_1', makeRequest());
    harness.broker.respond(allowInput());
    await expect(first).resolves.toMatchObject({ behavior: 'allow' });

    const reentry = await harness.broker.request('run_1', makeRequest());

    expect(reentry).toMatchObject({
      behavior: 'deny',
      message: DENIAL_MESSAGES.duplicateAfterResolution,
      interrupt: false,
    });
    expect(harness.store.getById('approval_1')?.status).toBe('approved_once');
    expect(harness.events.requestedEvents).toHaveLength(1);
    expect(harness.events.resolvedEvents).toHaveLength(1);
    expect(harness.events.errors).toContainEqual({
      code: 'APPROVAL_DUPLICATE_AFTER_RESOLUTION',
      message: DENIAL_MESSAGES.duplicateAfterResolution,
    });
    expect(harness.store.globalPendingCount()).toBe(0);
  });

  it('returns the same safe denial for completed deny/expired entries', async () => {
    const harness = setupBroker();
    const first = harness.broker.request('run_1', makeRequest());
    harness.broker.respond(allowInput({ decision: 'deny' }));
    await expect(first).resolves.toMatchObject({ behavior: 'deny' });

    const reentry = await harness.broker.request('run_1', makeRequest());

    expect(reentry).toEqual({
      behavior: 'deny',
      message: DENIAL_MESSAGES.denied,
      interrupt: false,
      toolUseID: 'toolu_1',
    });
    expect(harness.events.requestedEvents).toHaveLength(1);
    expect(harness.events.resolvedEvents).toHaveLength(1);
  });
});

describe('PermissionBroker invalidation', () => {
  it('invalidates only the cancelled run', async () => {
    const harness = setupBroker(['run_1', 'run_2']);
    const first = harness.broker.request(
      'run_1',
      makeRequest({ requestId: 'req_1' }),
    );
    harness.broker.request('run_2', makeRequest({ requestId: 'req_2' }));

    expect(harness.broker.invalidateRun('run_1', 'run_cancelled')).toBe(1);

    await expect(first).resolves.toEqual({
      behavior: 'deny',
      message: DENIAL_MESSAGES.runCancelled,
      interrupt: false,
      toolUseID: 'toolu_1',
    });
    expect(harness.store.getById('approval_1')).toMatchObject({
      status: 'invalidated',
      resolutionReason: 'run_cancelled',
      content: null,
      originalInput: null,
      resultPromise: null,
    });
    expect(harness.store.getById('approval_2')?.status).toBe('pending');
    expect(harness.store.pendingCount('run_1')).toBe(0);
    expect(harness.store.pendingCount('run_2')).toBe(1);
    expect(harness.events.resolvedEvents).toHaveLength(1);
    expect(harness.events.deniedEvents[0]).toMatchObject({
      runId: 'run_1',
      outcome: 'cancelled',
    });
    expect(harness.timers.activeCount()).toBe(1);
  });

  it('invalidates only the disabled workspace', async () => {
    const harness = setupBroker(['run_1', 'run_2']);
    moveRunTo(harness, 'run_2', 'ws_b', 'device_1');
    harness.broker.request('run_1', makeRequest({ requestId: 'req_1' }));
    harness.broker.request('run_2', makeRequest({ requestId: 'req_2' }));

    expect(
      harness.broker.invalidateWorkspace('ws_a', 'policy_disabled'),
    ).toBe(1);

    expect(harness.store.getById('approval_1')).toMatchObject({
      status: 'invalidated',
      resolutionReason: 'policy_disabled',
    });
    expect(harness.store.getById('approval_2')?.status).toBe('pending');
  });

  it('invalidates only the revoked device', async () => {
    const harness = setupBroker(['run_1', 'run_2']);
    moveRunTo(harness, 'run_2', 'ws_a', 'device_2');
    harness.broker.request('run_1', makeRequest({ requestId: 'req_1' }));
    harness.broker.request('run_2', makeRequest({ requestId: 'req_2' }));

    expect(harness.broker.invalidateDevice('device_1', 'device_revoked')).toBe(1);

    expect(harness.store.getById('approval_1')).toMatchObject({
      status: 'invalidated',
      resolutionReason: 'device_revoked',
    });
    expect(harness.store.getById('approval_2')?.status).toBe('pending');
  });

  it('invalidates everything on graceful shutdown', async () => {
    const harness = setupBroker(['run_1', 'run_2']);
    harness.broker.request('run_1', makeRequest({ requestId: 'req_1' }));
    harness.broker.request('run_2', makeRequest({ requestId: 'req_2' }));

    expect(harness.broker.invalidateAll('agent_shutdown')).toBe(2);

    expect(harness.store.globalPendingCount()).toBe(0);
    expect(harness.events.resolvedEvents).toHaveLength(2);
    expect(harness.events.resolvedEvents[0]?.resolutionReason).toBe(
      'agent_shutdown',
    );
  });

  it('publishes only one resolved event for repeated invalidation', async () => {
    const harness = setupBroker();
    harness.broker.request('run_1', makeRequest());

    expect(harness.broker.invalidateRun('run_1', 'run_cancelled')).toBe(1);
    expect(harness.broker.invalidateRun('run_1', 'run_cancelled')).toBe(0);
    harness.timers.advance(120_000);

    expect(harness.events.resolvedEvents).toHaveLength(1);
    expect(harness.events.deniedEvents).toHaveLength(1);
    expect(harness.store.getById('approval_1')?.status).toBe('invalidated');
  });

  it('does not rewrite an approved_once history on cancel', async () => {
    const harness = setupBroker();
    const pending = harness.broker.request('run_1', makeRequest());
    harness.broker.respond(allowInput());
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });

    expect(harness.broker.invalidateRun('run_1', 'run_cancelled')).toBe(0);

    expect(harness.store.getById('approval_1')).toMatchObject({
      status: 'approved_once',
      resolutionReason: 'user_allow_once',
    });
    expect(harness.events.resolvedEvents).toHaveLength(1);
  });

  it('clears text and timers while keeping the audit hash', async () => {
    const harness = setupBroker();
    const pending = harness.broker.request('run_1', makeRequest());
    const auditBefore = harness.store.audit('approval_1');
    expect(auditBefore).toBeNull();

    harness.broker.invalidateRun('run_1', 'sdk_aborted');

    const record = harness.store.getById('approval_1');
    expect(record).toMatchObject({
      status: 'invalidated',
      resolutionReason: 'sdk_aborted',
      content: null,
      originalInput: null,
      resultPromise: null,
    });
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(harness.timers.activeCount()).toBe(0);
    expect(harness.store.audit('approval_1')).toMatchObject({
      contentByteLength: expect.any(Number),
      contentSha256: expect.any(String),
    });
    expect(JSON.stringify(harness.store.audit('approval_1'))).not.toContain(
      'echo S03_ALPHA',
    );
  });
});