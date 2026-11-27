import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachmentStore } from '../src/attachment/attachment-store.js';
import { AgentOperations } from '../src/app/agent-operations.js';
import { AgentError } from '../src/command/errors.js';
import { CommandRouter } from '../src/command/router.js';
import { DeviceRecord } from '../src/domain/types.js';

const DEVICE: DeviceRecord = {
  deviceId: 'device_01',
  deviceName: 'iPhone',
  tokenHash: 'hash',
  createdAt: '2026-11-10T00:00:00.000Z',
  revokedAt: null,
};

const tempRoots: string[] = [];

function addTempRoot(root: string): void {
  tempRoots.push(root);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const base = (type: string, commandId: string): Record<string, unknown> => ({
  protocolVersion: 1,
  messageId: `msg_${commandId}`,
  commandId,
  traceId: `trace_${commandId}`,
  sourceDeviceId: DEVICE.deviceId,
  timestamp: 1762432800000,
  type,
});

const sessionStart = (commandId: string, workspaceId = 'default'): unknown => ({
  ...base('session.start', commandId),
  payload: {
    clientCapabilities: ['text'],
    workspaceId,
  },
});

const promptSend = (commandId: string, text: string): unknown => ({
  ...base('prompt.send', commandId),
  sessionId: 'session_01',
  payload: { text },
});

const runCancel = (commandId: string): unknown => ({
  ...base('run.cancel', commandId),
  sessionId: 'session_01',
  runId: 'run_01',
  payload: {},
});

type OperationSpies = Record<
  | 'listWorkspaces'
  | 'createSession'
  | 'listSessions'
  | 'resumeSession'
  | 'renameSession'
  | 'archiveSession'
  | 'startSession'
  | 'sendPrompt'
  | 'cancelRun'
  | 'removeQueuedRun'
  | 'snapshot'
  | 'listModels'
  | 'setSessionModel'
  | 'activeCount'
  | 'queuedRunCount',
  ReturnType<typeof vi.fn>
>;

interface Harness {
  router: CommandRouter;
  operations: OperationSpies;
}

function summary(sessionId = 'session_01') {
  return {
    sessionId,
    workspaceId: 'default',
    title: '会话 2026-11-12 10:00',
    claudeSessionId: null,
    status: 'idle' as const,
    activeRunId: null,
    queuedCount: 0,
    createdAt: 1_762_432_800_000,
    lastActivityAt: 1_762_432_800_000,
  };
}

function harness(
  overrides: Partial<OperationSpies> = {},
  attachments?: AttachmentStore,
): Harness {
  const operations = {
    listWorkspaces: vi.fn(() => ({
      workspaces: [{ workspaceId: 'default', displayName: 'Fixture' }],
      scheduler: {
        maxActiveRuns: 2,
        activeRunCount: 0,
        queuedRunCount: 0,
        maxQueuedRuns: 100,
      },
    })),
    createSession: vi.fn(() => summary()),
    listSessions: vi.fn(() => ({ sessions: [summary()], nextCursor: null })),
    resumeSession: vi.fn(() => summary()),
    renameSession: vi.fn(() => summary()),
    archiveSession: vi.fn(() => ({ ...summary(), status: 'archived' as const })),
    startSession: vi.fn((workspaceId: string) => {
      if (workspaceId !== 'default') {
        throw new AgentError('WORKSPACE_NOT_ALLOWED');
      }
      return summary();
    }),
    sendPrompt: vi.fn(async (_workspaceId: string | undefined, sessionId: string) => ({
      sessionId,
      runId: 'run_01',
      status: 'queued' as const,
    })),
    cancelRun: vi.fn(async (sessionId: string) => ({
      sessionId,
      runId: 'run_01',
      status: 'cancelling' as const,
    })),
    removeQueuedRun: vi.fn(async (sessionId: string, runId: string) => ({
      sessionId,
      runId,
      status: 'cancelled' as const,
      removed: true as const,
    })),
    snapshot: vi.fn(async (sessionId: string) => ({
      protocolVersion: 1 as const,
      messageId: 'msg_snapshot',
      timestamp: 0,
      type: 'session.snapshot' as const,
      payload: { sessionId },
    })),
    listModels: vi.fn(async () => [{ value: 'opus', displayName: 'Opus', description: '' }]),
    setSessionModel: vi.fn(async (_sessionId: string, model: string | null) => ({
      ...summary(),
      model,
    })),
    activeCount: vi.fn(() => 0),
    queuedRunCount: vi.fn(() => 0),
    ...(overrides as Partial<OperationSpies>),
  } as OperationSpies;
  return {
    router: new CommandRouter({
      operations: operations as unknown as AgentOperations,
      ...(attachments === undefined ? {} : { attachments }),
    }),
    operations,
  };
}

describe('CommandRouter', () => {
  it('routes session.start and returns the session summary', async () => {
    const { router, operations } = harness();

    const result = await router.route(sessionStart('cmd_1'), DEVICE);

    expect(result.type).toBe('command.result');
    expect(result.commandId).toBe('cmd_1');
    expect(result.traceId).toBe('trace_cmd_1');
    expect(result.payload).toMatchObject({
      status: 'ok',
      duplicate: false,
      data: { sessionId: expect.stringMatching(/^session_/) },
    });
    expect(operations.startSession).toHaveBeenCalledWith('default');
  });

  it('returns the same session for a repeated session.start', async () => {
    const { router } = harness();
    const first = await router.route(sessionStart('cmd_1'), DEVICE);
    const second = await router.route(sessionStart('cmd_2'), DEVICE);

    expect(second.payload).toMatchObject({
      status: 'ok',
      data: {
        sessionId: (first.payload as unknown as { data: { sessionId: string } })
          .data.sessionId,
      },
    });
  });

  it('runs concurrent calls with the same commandId once', async () => {
    const { router, operations } = harness();

    const [first, second] = await Promise.all([
      router.route(sessionStart('cmd_1'), DEVICE),
      router.route(sessionStart('cmd_1'), DEVICE),
    ]);

    expect(operations.startSession).toHaveBeenCalledTimes(1);
    expect(first.payload).toMatchObject({ status: 'ok', duplicate: false });
    expect(second.payload).toMatchObject({ status: 'ok', duplicate: true });
  });

  it('rejects an invalid envelope before routing', async () => {
    const { router, operations } = harness();

    const result = await router.route(
      { ...(sessionStart('cmd_1') as object), protocolVersion: 2 },
      DEVICE,
    );

    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_MESSAGE' },
    });
    expect(operations.startSession).not.toHaveBeenCalled();
  });

  it('rejects an unknown command type', async () => {
    const { router } = harness();

    const result = await router.route(
      { ...(sessionStart('cmd_1') as object), type: 'prompt.explode' },
      DEVICE,
    );

    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'UNKNOWN_MESSAGE_TYPE' },
    });
  });

  it('rejects a workspace other than the authorized one', async () => {
    const { router } = harness();

    const result = await router.route(sessionStart('cmd_1', 'other'), DEVICE);

    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'WORKSPACE_NOT_ALLOWED' },
    });
  });

  it('rejects a blank prompt without starting a run', async () => {
    const { router, operations } = harness();

    const result = await router.route(promptSend('cmd_1', '   '), DEVICE);

    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_MESSAGE' },
    });
    expect(operations.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects a prompt over 16,384 utf-8 bytes', async () => {
    const { router, operations } = harness();

    const result = await router.route(promptSend('cmd_1', 'a'.repeat(16_385)), DEVICE);

    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_MESSAGE' },
    });
    expect(operations.sendPrompt).not.toHaveBeenCalled();
  });

  it('accepts a prompt of exactly 16,384 utf-8 bytes', async () => {
    const { router } = harness();

    const result = await router.route(promptSend('cmd_1', 'a'.repeat(16_384)), DEVICE);

    expect(result.payload).toMatchObject({ status: 'ok' });
  });

  it('accepts an image-only prompt and links it to the run', async () => {
    const root = mkdtempSync(join(tmpdir(), 's06-router-attach-'));
    const attachments = new AttachmentStore(root);
    const saved = attachments.save({
      deviceId: DEVICE.deviceId,
      mediaType: 'image/jpeg',
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    });
    const { router, operations } = harness({}, attachments);
    addTempRoot(root);

    const result = await router.route(
      {
        ...(base('prompt.send', 'cmd_img') as object),
        sessionId: 'session_01',
        payload: { text: '', attachments: [saved] },
      },
      DEVICE,
    );

    expect(result.payload).toMatchObject({ status: 'ok' });
    expect(operations.sendPrompt).toHaveBeenCalledWith(
      undefined,
      'session_01',
      '',
      'cmd_img',
      'trace_cmd_img',
      DEVICE.deviceId,
      [saved],
    );
    expect(attachments.loadForRun('run_01')).toHaveLength(1);
  });

  it('rejects attachments when no attachment store is wired', async () => {
    const { router, operations } = harness();

    const result = await router.route(
      {
        ...(base('prompt.send', 'cmd_img') as object),
        sessionId: 'session_01',
        payload: {
          text: '看图',
          attachments: [
            {
              attachmentId: 'att_12345678',
              mediaType: 'image/jpeg',
              size: 4,
            },
          ],
        },
      },
      DEVICE,
    );

    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_MESSAGE' },
    });
    expect(operations.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects an unsupported attachment media type', async () => {
    const root = mkdtempSync(join(tmpdir(), 's06-router-bad-attach-'));
    addTempRoot(root);
    const { router, operations } = harness({}, new AttachmentStore(root));

    const result = await router.route(
      {
        ...(base('prompt.send', 'cmd_img') as object),
        sessionId: 'session_01',
        payload: {
          text: '看图',
          attachments: [
            { attachmentId: 'att_12345678', mediaType: 'image/gif', size: 4 },
          ],
        },
      },
      DEVICE,
    );

    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_MESSAGE' },
    });
    expect(operations.sendPrompt).not.toHaveBeenCalled();
  });

  it('maps a missing session to SESSION_NOT_FOUND', async () => {
    const { router } = harness({
      sendPrompt: vi.fn(async () => {
        throw new AgentError('SESSION_NOT_FOUND');
      }),
    });

    const result = await router.route(promptSend('cmd_1', 'hello'), DEVICE);

    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'SESSION_NOT_FOUND' },
    });
  });

  it('maps a busy session to SESSION_BUSY', async () => {
    const { router } = harness({
      sendPrompt: vi.fn(async () => {
        throw new AgentError('SESSION_BUSY', 'run in progress', true);
      }),
    });

    const result = await router.route(promptSend('cmd_1', 'hello'), DEVICE);

    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'SESSION_BUSY', retryable: true },
    });
  });

  it('carries queue-full details without prompt content', async () => {
    const { router } = harness({
      sendPrompt: vi.fn(async () => {
        throw new AgentError('QUEUE_FULL', 'QUEUE_FULL', false, {
          scope: 'session',
          limit: 20,
        });
      }),
    });

    const result = await router.route(promptSend('cmd_1', 'secret'), DEVICE);

    expect(result.payload).toMatchObject({
      status: 'error',
      error: {
        code: 'QUEUE_FULL',
        details: { scope: 'session', limit: 20 },
      },
    });
    expect(JSON.stringify(result.payload)).not.toContain('secret');
  });

  it('maps an inactive run cancel to RUN_NOT_ACTIVE', async () => {
    const { router } = harness({
      cancelRun: vi.fn(async () => {
        throw new AgentError('RUN_NOT_ACTIVE');
      }),
    });

    const result = await router.route(runCancel('cmd_1'), DEVICE);

    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'RUN_NOT_ACTIVE' },
    });
  });

  it('routes queue.remove through the operations layer', async () => {
    const { router, operations } = harness();

    const result = await router.route(
      {
        ...base('queue.remove', 'cmd_1'),
        sessionId: 'session_01',
        runId: 'run_01',
        payload: {},
      },
      DEVICE,
    );

    expect(result.payload).toMatchObject({
      status: 'ok',
      data: { removed: true, status: 'cancelled' },
    });
    expect(operations.removeQueuedRun).toHaveBeenCalledWith(
      'session_01',
      'run_01',
    );
  });

  it('returns a snapshot result for session.snapshot', async () => {
    const { router, operations } = harness();

    const result = await router.route(
      { ...base('session.snapshot', 'cmd_1'), sessionId: 'session_01', payload: {} },
      DEVICE,
    );

    expect(result.payload).toMatchObject({ status: 'ok' });
    expect(operations.snapshot).toHaveBeenCalledWith('session_01');
  });

  it('routes models.list and returns the catalog', async () => {
    const models = [{ value: 'opus', displayName: 'Opus', description: '' }];
    const { router, operations } = harness({
      listModels: vi.fn(async () => models),
    });

    const result = await router.route(
      { ...base('models.list', 'cmd_1'), payload: { workspaceId: 'default' } },
      DEVICE,
    );

    expect(result.payload).toMatchObject({ status: 'ok', data: { models } });
    expect(operations.listModels).toHaveBeenCalledWith('default');
  });

  it('rejects session.set-model without a sessionId', async () => {
    const { router, operations } = harness();

    const result = await router.route(
      { ...base('session.set-model', 'cmd_1'), payload: { model: 'opus' } },
      DEVICE,
    );

    // 信封 schema 要求 sessionId；校验层先于 dispatch 拒绝。
    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_MESSAGE' },
    });
    expect(operations.setSessionModel).not.toHaveBeenCalled();
  });

  it('maps an unknown session to SESSION_NOT_FOUND', async () => {
    const { router } = harness({
      setSessionModel: vi.fn(async () => {
        throw new AgentError('SESSION_NOT_FOUND');
      }),
    });

    const result = await router.route(
      {
        ...base('session.set-model', 'cmd_1'),
        sessionId: 'session_404',
        payload: { model: 'opus' },
      },
      DEVICE,
    );

    expect(result.payload).toMatchObject({
      status: 'error',
      error: { code: 'SESSION_NOT_FOUND' },
    });
  });

  it('passes model null through session.set-model', async () => {
    const { router, operations } = harness();

    const result = await router.route(
      {
        ...base('session.set-model', 'cmd_1'),
        sessionId: 'session_01',
        payload: { model: null },
      },
      DEVICE,
    );

    expect(result.payload).toMatchObject({ status: 'ok' });
    expect(operations.setSessionModel).toHaveBeenCalledWith('session_01', null);
  });
});