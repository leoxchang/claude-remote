import { describe, expect, it } from 'vitest';

import {
  ApprovalContentController,
  ApprovalContentRateLimiter,
} from '../src/approval/approval-content-controller.js';
import { sha256Base64Url } from '../src/security/random.js';
import {
  BrokerHarness,
  makeRequest,
  setupBroker,
} from './approval-test-harness.js';

function controllerFor(harness: BrokerHarness): ApprovalContentController {
  return new ApprovalContentController({
    store: harness.store,
    settleExpired: (approvalId) => {
      harness.broker.settleIfExpired(approvalId);
    },
    rateLimiter: new ApprovalContentRateLimiter(),
    clock: harness.clock,
  });
}

describe('ApprovalContentController', () => {
  it('reassembles exact content with matching hash and descriptor', () => {
    const harness = setupBroker();
    harness.broker.request(
      'run_1',
      makeRequest({
        input: { command: 'echo 中文🙂', description: 'fixture' },
      }),
    );
    const record = harness.store.getById('approval_1');
    const content = record?.content;
    if (content === null || content === undefined) {
      throw new Error('fixture pending must have content');
    }
    const controller = controllerFor(harness);

    const chunks = [];
    for (let index = 0; index < content.chunks.length; index += 1) {
      chunks.push(
        controller.readChunk({
          approvalId: 'approval_1',
          chunkIndex: index,
          deviceId: 'device_1',
        }),
      );
    }

    expect(chunks.map((chunk) => chunk.text).join('')).toBe(content.jsonText);
    expect(sha256Base64Url(chunks.map((chunk) => chunk.text).join(''))).toBe(
      content.sha256,
    );
    expect(chunks[0]).toMatchObject({
      approvalId: 'approval_1',
      chunkIndex: 0,
      chunkCount: content.chunks.length,
      encoding: 'json-utf8',
      byteLength: content.byteLength,
      sha256: content.sha256,
    });
  });

  it('rejects out-of-range or fractional chunk indexes', () => {
    const harness = setupBroker();
    harness.broker.request('run_1', makeRequest());
    const controller = controllerFor(harness);
    const record = harness.store.getById('approval_1');
    const chunkCount = record?.content?.chunks.length ?? 0;

    for (const chunkIndex of [-1, 0.5, chunkCount]) {
      expect(() =>
        controller.readChunk({
          approvalId: 'approval_1',
          chunkIndex,
          deviceId: 'device_1',
        }),
      ).toThrow('INVALID_MESSAGE');
    }
  });

  it('rejects wrong devices and unknown approvals', () => {
    const harness = setupBroker();
    harness.broker.request('run_1', makeRequest());
    const controller = controllerFor(harness);

    expect(() =>
      controller.readChunk({
        approvalId: 'approval_1',
        chunkIndex: 0,
        deviceId: 'device_2',
      }),
    ).toThrow('FORBIDDEN');
    expect(() =>
      controller.readChunk({
        approvalId: 'approval_missing',
        chunkIndex: 0,
        deviceId: 'device_1',
      }),
    ).toThrow('APPROVAL_NOT_FOUND');
  });

  it('settles expiry before reading, even when the timer has not run', () => {
    const harness = setupBroker();
    harness.broker.request('run_1', makeRequest());
    const controller = controllerFor(harness);
    harness.clock.advanceMonotonic(120_000);

    expect(() =>
      controller.readChunk({
        approvalId: 'approval_1',
        chunkIndex: 0,
        deviceId: 'device_1',
      }),
    ).toThrow('APPROVAL_EXPIRED');
    expect(harness.store.getById('approval_1')?.status).toBe('expired');
    expect(harness.events.resolvedEvents).toHaveLength(1);
  });

  it('rejects reads after any terminal state', () => {
    const harness = setupBroker();
    harness.broker.request('run_1', makeRequest());
    const controller = controllerFor(harness);
    harness.broker.respond({
      approvalId: 'approval_1',
      workspaceId: 'ws_a',
      sessionId: 'session_run_1',
      runId: 'run_1',
      deviceId: 'device_1',
      commandId: 'cmd_1',
      decision: 'deny',
    });

    expect(() =>
      controller.readChunk({
        approvalId: 'approval_1',
        chunkIndex: 0,
        deviceId: 'device_1',
      }),
    ).toThrow('APPROVAL_ALREADY_RESOLVED');
  });

  it('enforces 120 reads per rolling minute per device', () => {
    const harness = setupBroker();
    harness.broker.request('run_1', makeRequest());
    const controller = controllerFor(harness);

    for (let index = 0; index < 120; index += 1) {
      expect(() =>
        controller.readChunk({
          approvalId: 'approval_1',
          chunkIndex: 0,
          deviceId: 'device_1',
        }),
      ).not.toThrow();
    }
    expect(() =>
      controller.readChunk({
        approvalId: 'approval_1',
        chunkIndex: 0,
        deviceId: 'device_1',
      }),
    ).toThrow('RATE_LIMITED');

    harness.clock.advanceMonotonic(60_001);
    expect(() =>
      controller.readChunk({
        approvalId: 'approval_1',
        chunkIndex: 0,
        deviceId: 'device_1',
      }),
    ).not.toThrow();
  });

  it('keeps per-device counters separate behind the same localhost address', () => {
    const limiter = new ApprovalContentRateLimiter();

    for (let index = 0; index < 120; index += 1) {
      expect(limiter.consume('device_1', 1_000)).toBe(true);
    }
    expect(limiter.consume('device_1', 1_000)).toBe(false);
    expect(limiter.consume('device_2', 1_000)).toBe(true);
  });

  it('does not modify the stored record or pending state', () => {
    const harness = setupBroker();
    harness.broker.request('run_1', makeRequest());
    const controller = controllerFor(harness);
    const before = harness.store.getById('approval_1');
    const pendingBefore = harness.store.globalPendingCount();

    controller.readChunk({
      approvalId: 'approval_1',
      chunkIndex: 0,
      deviceId: 'device_1',
    });

    const after = harness.store.getById('approval_1');
    expect(after).toBe(before);
    expect(harness.store.globalPendingCount()).toBe(pendingBefore);
    expect(harness.events.resolvedEvents).toHaveLength(0);
  });
});