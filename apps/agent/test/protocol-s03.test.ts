import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateProtocolMessage } from '@claude-remote/protocol/validator';
import { CommandMessage } from '@claude-remote/protocol/types';

import { AgentOperations, SchedulerSummary } from '../src/app/agent-operations.js';
import { CommandRouter } from '../src/command/router.js';
import { AgentError } from '../src/command/errors.js';
import { DeviceRecord } from '../src/domain/types.js';
import {
  ApprovalSummary,
  PermissionResponseInput,
  PermissionResponseResult,
} from '../src/approval/approval-types.js';
import { SessionListInput, SessionPage } from '../src/session/session-list.js';
import { SessionSummary } from '../src/session/session-summary.js';
import { SessionSnapshotEvent } from '../src/session/session-controller.js';
import { PromptAccepted } from '../src/run/run-scheduler.js';

function example(name: string): unknown {
  const path = fileURLToPath(
    new URL(`../../../protocol/v1/examples/s03/${name}`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const DEVICE: DeviceRecord = {
  deviceId: 'device_01',
  deviceName: 'iPhone',
  tokenHash: 'hash',
  createdAt: '2026-11-12T00:00:00.000Z',
  revokedAt: null,
};

class StubOperations implements AgentOperations {
  readonly responses: PermissionResponseInput[] = [];
  failure: AgentError | null = null;
  pendingApprovalsResult: ApprovalSummary[] = [];

  listWorkspaces(): { workspaces: []; scheduler: SchedulerSummary } {
    throw new AgentError('INVALID_MESSAGE');
  }

  createSession(): SessionSummary {
    throw new AgentError('INVALID_MESSAGE');
  }

  listSessions(): SessionPage {
    throw new AgentError('INVALID_MESSAGE');
  }

  resumeSession(): SessionSummary {
    throw new AgentError('INVALID_MESSAGE');
  }

  renameSession(): SessionSummary {
    throw new AgentError('INVALID_MESSAGE');
  }

  archiveSession(): SessionSummary {
    throw new AgentError('INVALID_MESSAGE');
  }

  startSession(): SessionSummary {
    throw new AgentError('INVALID_MESSAGE');
  }

  sendPrompt(): Promise<PromptAccepted> {
    throw new AgentError('INVALID_MESSAGE');
  }

  async cancelRun(): Promise<never> {
    throw new AgentError('INVALID_MESSAGE');
  }

  async removeQueuedRun(): Promise<never> {
    throw new AgentError('INVALID_MESSAGE');
  }

  async snapshot(): Promise<SessionSnapshotEvent> {
    throw new AgentError('INVALID_MESSAGE');
  }

  respondPermission(input: PermissionResponseInput): PermissionResponseResult {
    this.responses.push(input);
    if (this.failure !== null) throw this.failure;
    return {
      approvalId: input.approvalId,
      status: input.decision === 'allow_once' ? 'approved_once' : 'denied',
      resolvedAt: 1_762_432_860_000,
    };
  }

  pendingApprovals(): ApprovalSummary[] {
    return this.pendingApprovalsResult;
  }

  activeCount(): number {
    return 0;
  }

  queuedRunCount(): number {
    return 0;
  }
}

function respondCommand(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(example('permission-respond.json') as Record<string, unknown>),
    ...overrides,
  };
}

describe('S03 protocol examples', () => {
  it('accepts every shared S03 message example', () => {
    for (const name of [
      'permission-requested.json',
      'permission-resolved.json',
      'permission-respond.json',
      'duplicate-after-resolution.json',
      'unsupported-interaction.json',
      'session-snapshot.json',
    ]) {
      expect(validateProtocolMessage(example(name))).toMatchObject({
        valid: true,
      });
    }
  });

  it('rejects payloads that try to carry authorization content', () => {
    for (const payload of [
      { decision: 'allow_once', input: { command: 'secret' } },
      { decision: 'allow_once', updatedInput: { command: 'secret' } },
      { decision: 'allow_once', updatedPermissions: [] },
      { decision: 'allow_once', contentHash: 'abc' },
      { decision: 'always' },
      {},
    ]) {
      const result = validateProtocolMessage(respondCommand({ payload }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.every((error) => error.code === 'INVALID_MESSAGE')).toBe(
          true,
        );
        expect(JSON.stringify(result.errors)).not.toContain('secret');
      }
    }
  });

  it('requires every association id on permission.respond', () => {
    for (const key of [
      'workspaceId',
      'sessionId',
      'runId',
      'approvalId',
      'commandId',
      'traceId',
    ]) {
      const command = respondCommand();
      delete command[key];
      expect(validateProtocolMessage(command).valid).toBe(false);
    }
  });
});

describe('S03 command routing', () => {
  it('returns the first result for the same commandId without deciding twice', async () => {
    const operations = new StubOperations();
    const router = new CommandRouter({ operations });
    const command = respondCommand() as unknown as CommandMessage;

    const first = await router.route(command, DEVICE);
    const second = await router.route(
      { ...command, messageId: 'msg_retry' },
      DEVICE,
    );

    expect(first.payload).toMatchObject({
      status: 'ok',
      duplicate: false,
      data: { status: 'approved_once' },
    });
    expect(second.payload).toMatchObject({ status: 'ok', duplicate: true });
    expect(operations.responses).toHaveLength(1);
  });

  it('rejects a changed decision under the same commandId', async () => {
    const operations = new StubOperations();
    const router = new CommandRouter({ operations });
    const command = respondCommand() as unknown as CommandMessage;

    await router.route(command, DEVICE);
    const conflict = await router.route(
      respondCommand({ payload: { decision: 'deny' } }) as unknown as CommandMessage,
      DEVICE,
    );

    expect(conflict.payload).toMatchObject({
      status: 'error',
      error: { code: 'COMMAND_ID_CONFLICT' },
    });
    expect(operations.responses).toHaveLength(1);
  });

  it('maps terminal and mismatch errors to stable codes', async () => {
    const router = new CommandRouter({ operations: new StubOperations() });
    const command = respondCommand() as unknown as CommandMessage;

    for (const code of [
      'APPROVAL_EXPIRED',
      'APPROVAL_ALREADY_RESOLVED',
      'APPROVAL_SESSION_MISMATCH',
    ] as const) {
      const operations = new StubOperations();
      operations.failure = new AgentError(code);
      const result = await new CommandRouter({ operations }).route(
        command,
        DEVICE,
      );
      expect(result.payload).toMatchObject({
        status: 'error',
        error: { code },
      });
    }

    const forbidden = await router.route(
      respondCommand({ sourceDeviceId: 'device_other' }) as unknown as CommandMessage,
      DEVICE,
    );
    expect(forbidden.payload).toMatchObject({
      status: 'error',
      error: { code: 'FORBIDDEN' },
    });
  });

  it('passes the authenticated device, never the app-supplied one', async () => {
    const operations = new StubOperations();
    const router = new CommandRouter({ operations });

    await router.route(
      respondCommand() as unknown as CommandMessage,
      DEVICE,
    );

    expect(operations.responses[0]).toMatchObject({
      deviceId: 'device_01',
      approvalId: 'approval_01',
      workspaceId: 'ws_01',
      sessionId: 'session_01',
      runId: 'run_01',
      decision: 'allow_once',
    });
  });
});