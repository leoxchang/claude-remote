import { describe, expect, it, vi } from 'vitest';

import { AgentOperations } from '../../src/app/agent-operations.js';
import { CommandRouter } from '../../src/command/router.js';
import { DeviceRecord } from '../../src/domain/types.js';

const DEVICE: DeviceRecord = {
  deviceId: 'device_authenticated',
  deviceName: 'iPhone',
  tokenHash: 'hash',
  createdAt: '2026-11-10T00:00:00.000Z',
  revokedAt: null,
};

function promptSend(
  commandId: string,
  sourceDeviceId = DEVICE.deviceId,
): unknown {
  return {
    protocolVersion: 1,
    messageId: `msg_${commandId}`,
    commandId,
    traceId: `trace_${commandId}`,
    sourceDeviceId,
    timestamp: 1_762_432_800_000,
    type: 'prompt.send',
    sessionId: 'session_01',
    payload: { text: 'S04_QUEUED_ONLY' },
  };
}

function harness() {
  const sendPrompt = vi.fn(
    async (
      _workspaceId: string | undefined,
      sessionId: string,
      _text: string,
      commandId: string,
      _traceId: string,
      _deviceId: string,
    ) => ({
      sessionId,
      runId: `run_${commandId}`,
      status: 'queued' as const,
    }),
  );
  const operations = {
    sendPrompt,
    listWorkspaces: vi.fn(() => ({
      workspaces: [],
      scheduler: {
        maxActiveRuns: 2,
        activeRunCount: 0,
        queuedRunCount: 0,
        maxQueuedRuns: 100,
        pendingApprovalCount: 0,
      },
    })),
    activeCount: vi.fn(() => 0),
    queuedRunCount: vi.fn(() => 0),
  } as unknown as AgentOperations;
  return { router: new CommandRouter({ operations }), sendPrompt };
}

describe('prompt.send queued-only regression', () => {
  it('returns queued from the first result', async () => {
    const { router } = harness();
    const result = await router.route(promptSend('cmd_1'), DEVICE);
    expect(result.payload).toMatchObject({
      status: 'ok',
      data: { sessionId: 'session_01', runId: 'run_cmd_1', status: 'queued' },
      duplicate: false,
    });
  });

  it('uses the authenticated device, not sourceDeviceId', async () => {
    const { router, sendPrompt } = harness();
    await router.route(promptSend('cmd_1'), DEVICE);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0]?.[5]).toBe('device_authenticated');

    const forged = await router.route(
      promptSend('cmd_2', 'device_someone_else'),
      DEVICE,
    );
    expect(forged.payload).toMatchObject({ status: 'error' });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('executes once for a retried commandId', async () => {
    const { router, sendPrompt } = harness();
    const first = await router.route(promptSend('cmd_1'), DEVICE);
    const second = await router.route(promptSend('cmd_1'), DEVICE);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(second.payload).toMatchObject({ status: 'ok', duplicate: true });
    expect(first.payload).toMatchObject({ status: 'ok', duplicate: false });
  });
});