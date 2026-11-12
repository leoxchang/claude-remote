import { describe, expect, it } from 'vitest';

import { DENIAL_MESSAGES } from '../src/approval/permission-broker.js';
import { SdkPermissionRequest } from '../src/approval/approval-types.js';
import {
  makeRequest as request,
  setupBroker as setup,
} from './approval-test-harness.js';

describe('PermissionBroker request creation', () => {
  it('shares the exact promise for a pending reentry', () => {
    const harness = setup();
    const signal = new AbortController();
    const first = harness.broker.request(
      'run_1',
      request({ signal: signal.signal }),
    );

    const second = harness.broker.request(
      'run_1',
      request({ signal: signal.signal }),
    );

    expect(second).toBe(first);
    expect(harness.events.requestedEvents).toHaveLength(1);
    expect(harness.store.globalPendingCount()).toBe(1);
    const summary = harness.events.requestedEvents[0];
    expect(summary?.toolName).toBe('Bash');
    expect(JSON.stringify(summary)).not.toContain('echo S03_ALPHA');
    expect(harness.store.getById('approval_1')?.content).not.toBeNull();
  });

  it('creates separate approvals for the same toolUseID with new requestIds', () => {
    const harness = setup();
    harness.broker.request('run_1', request({ requestId: 'req_1' }));
    harness.broker.request(
      'run_1',
      request({ requestId: 'req_2', toolUseID: 'toolu_1' }),
    );

    expect(harness.events.requestedEvents).toHaveLength(2);
    expect(
      harness.events.requestedEvents.map((summary) => summary.approvalId),
    ).toEqual(['approval_1', 'approval_2']);
  });

  it('denies a fingerprint conflict without creating another card', () => {
    const harness = setup();
    const first = harness.broker.request('run_1', request());
    const conflicting = harness.broker.request(
      'run_1',
      request({ input: { command: 'echo DIFFERENT' } }),
    );

    expect(conflicting).not.toBe(first);
    expect(harness.events.requestedEvents).toHaveLength(1);
    expect(harness.store.globalPendingCount()).toBe(1);
    expect(harness.events.errors).toContainEqual(
      expect.objectContaining({
        code: 'INTERNAL_ERROR',
        message: DENIAL_MESSAGES.conflict,
      }),
    );
    return expect(conflicting).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('enforces the per-run pending limit at 8', async () => {
    const harness = setup();
    const promises: Array<Promise<unknown>> = [];
    for (let index = 0; index < 8; index += 1) {
      promises.push(
        harness.broker.request(
          'run_1',
          request({ requestId: `req_${index}`, toolUseID: `toolu_${index}` }),
        ),
      );
    }
    const ninth = await harness.broker.request(
      'run_1',
      request({ requestId: 'req_8', toolUseID: 'toolu_8' }),
    );

    expect(promises).toHaveLength(8);
    expect(ninth).toMatchObject({
      behavior: 'deny',
      message: DENIAL_MESSAGES.capacity,
      interrupt: false,
    });
    expect(harness.events.requestedEvents).toHaveLength(8);
    expect(harness.store.pendingCount('run_1')).toBe(8);
    expect(harness.events.errors).toContainEqual(
      expect.objectContaining({
        code: 'APPROVAL_CAPACITY_EXCEEDED',
        message: DENIAL_MESSAGES.capacity,
      }),
    );
  });

  it('enforces the global pending limit at 16', async () => {
    const runIds = Array.from({ length: 9 }, (_unused, index) => `run_${index}`);
    const harness = setup(runIds);
    for (const runId of runIds.slice(0, 8)) {
      for (let index = 0; index < 2; index += 1) {
        harness.broker.request(
          runId,
          request({ requestId: `req_${index}`, toolUseID: `toolu_${runId}_${index}` }),
        );
      }
    }
    expect(harness.store.globalPendingCount()).toBe(16);

    const seventeenth = await harness.broker.request(
      'run_8',
      request({ requestId: 'req_0', toolUseID: 'toolu_17' }),
    );

    expect(seventeenth).toMatchObject({
      behavior: 'deny',
      message: DENIAL_MESSAGES.capacity,
    });
    expect(harness.store.globalPendingCount()).toBe(16);
  });
});

describe('PermissionBroker pre-creation denials', () => {
  it('rejects aborted, unbound, disabled, revoked and unsupported requests', async () => {
    const harness = setup(['run_1', 'run_2']);
    const controller = new AbortController();
    controller.abort();

    const cases: Array<{ request: SdkPermissionRequest; runId: string }> = [
      { runId: 'run_1', request: request({ signal: controller.signal }) },
      { runId: 'run_missing', request: request() },
    ];
    for (const entry of cases) {
      const result = await harness.broker.request(entry.runId, entry.request);
      expect(result).toMatchObject({ behavior: 'deny', interrupt: false });
    }

    harness.ports.acceptingApprovals = false;
    expect(
      await harness.broker.request('run_1', request({ requestId: 'req_accept' })),
    ).toMatchObject({ behavior: 'deny', message: DENIAL_MESSAGES.runNotAccepting });
    harness.ports.acceptingApprovals = true;

    harness.ports.mode = 'deny';
    expect(
      await harness.broker.request('run_1', request({ requestId: 'req_mode' })),
    ).toMatchObject({
      behavior: 'deny',
      message: DENIAL_MESSAGES.workspaceDisabled,
    });
    harness.ports.mode = 'allow_once';

    harness.ports.deviceIsActive = false;
    expect(
      await harness.broker.request('run_1', request({ requestId: 'req_device' })),
    ).toMatchObject({ behavior: 'deny', message: DENIAL_MESSAGES.deviceInactive });
    harness.ports.deviceIsActive = true;

    const unsupported = [
      {
        request: request({
          requestId: 'req_unknown',
          toolName: 'CronCreate',
        }),
        code: 'APPROVAL_TOOL_UNSUPPORTED',
      },
      {
        request: request({
          requestId: 'req_ask',
          toolName: 'AskUserQuestion',
        }),
        code: 'UNSUPPORTED_USER_INTERACTION',
      },
      {
        request: request({
          requestId: 'req_mcp',
          toolName: 'mcp__server__tool',
        }),
        code: 'UNSUPPORTED_USER_INTERACTION',
      },
    ];
    for (const entry of unsupported) {
      expect(await harness.broker.request('run_1', entry.request)).toMatchObject(
        { behavior: 'deny' },
      );
      expect(harness.events.errors).toContainEqual(
        expect.objectContaining({ code: entry.code }),
      );
    }

    expect(
      await harness.broker.request(
        'run_1',
        request({ requestId: 'req_unserializable', input: { value: 1n } }),
      ),
    ).toMatchObject({
      behavior: 'deny',
      message: DENIAL_MESSAGES.unavailable,
    });
    expect(
      await harness.broker.request(
        'run_1',
        request({
          requestId: 'req_large',
          input: { text: 'a'.repeat(1024 * 1024 + 1) },
        }),
      ),
    ).toMatchObject({
      behavior: 'deny',
      message: DENIAL_MESSAGES.unavailable,
    });

    expect(harness.events.requestedEvents).toHaveLength(0);
    expect(harness.events.resolvedEvents).toHaveLength(0);
    expect(harness.store.globalPendingCount()).toBe(0);
  });

  it('reports PERMISSION_REQUIRED for a default-deny workspace', async () => {
    const harness = setup();
    harness.ports.mode = 'deny';

    await harness.broker.request('run_1', request());

    expect(harness.events.errors).toContainEqual(
      expect.objectContaining({
        code: 'PERMISSION_REQUIRED',
        message: DENIAL_MESSAGES.workspaceDisabled,
      }),
    );
  });
});

describe('PermissionBroker append failure', () => {
  it('removes the phantom pending and never publishes resolved', async () => {
    const harness = setup();
    harness.events.throwOnRequested = true;

    const result = await harness.broker.request('run_1', request());

    expect(result).toMatchObject({
      behavior: 'deny',
      message: DENIAL_MESSAGES.unavailable,
    });
    expect(harness.store.getById('approval_1')).toBeNull();
    expect(harness.store.globalPendingCount()).toBe(0);
    expect(harness.events.requestedEvents).toHaveLength(0);
    expect(harness.events.resolvedEvents).toHaveLength(0);
    expect(harness.timers.activeCount()).toBe(0);
    expect(harness.ports.counts.at(-1)).toEqual({ runId: 'run_1', count: 0 });

    harness.timers.advance(120_000);
    expect(harness.events.resolvedEvents).toHaveLength(0);
  });
});