import {
  CommandMessage,
  CommandResultMessage,
  CommandResultPayload,
} from '@claude-remote/protocol/types';
import { validateProtocolMessage } from '@claude-remote/protocol/validator';

import { DeviceRecord, JsonObject } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';
import { AgentOperations } from '../session/session-controller.js';
import { CommandIdentity } from './canonical-request.js';
import { AgentError } from './errors.js';
import { InMemoryIdempotency } from './idempotency.js';

/** prompt 的 UTF-8 上限（16 KiB）。 */
const MAX_PROMPT_BYTES = 16 * 1024;

const MESSAGE_ID_BYTES = 9;

const COMMAND_TYPES: readonly string[] = [
  'session.start',
  'prompt.send',
  'run.cancel',
  'session.snapshot',
];

/** 命令路由依赖；幂等表可注入以便测试。 */
export interface CommandRouterDependencies {
  operations: AgentOperations;
  idempotency?: InMemoryIdempotency;
}

type DispatchPayload =
  | { status: 'ok'; data: Record<string, unknown> }
  | {
      status: 'error';
      error: { code: string; message: string; retryable: boolean };
    };

/** 先校验信封与载荷，再交给幂等表和 AgentOperations。 */
export class CommandRouter {
  private readonly operations: AgentOperations;
  private readonly idempotency: InMemoryIdempotency;

  constructor(deps: CommandRouterDependencies) {
    this.operations = deps.operations;
    this.idempotency = deps.idempotency ?? new InMemoryIdempotency();
  }

  /** 处理一条命令并返回 command.result。 */
  async route(
    message: unknown,
    device: DeviceRecord,
  ): Promise<CommandResultMessage> {
    const validation = validateProtocolMessage(message);
    if (!validation.valid) {
      const unknownType = validation.errors.some(
        (error) => error.code === 'UNKNOWN_MESSAGE_TYPE',
      );
      return this.errorResult(
        message,
        unknownType ? 'UNKNOWN_MESSAGE_TYPE' : 'INVALID_MESSAGE',
        false,
      );
    }

    const command = validation.message as CommandMessage;
    if (!COMMAND_TYPES.includes(command.type)) {
      return this.errorResult(command, 'UNKNOWN_MESSAGE_TYPE', false);
    }
    if (
      typeof command.sourceDeviceId === 'string' &&
      command.sourceDeviceId !== device.deviceId
    ) {
      return this.errorResult(command, 'FORBIDDEN', false);
    }

    const { value, duplicate } = await this.idempotent(command);
    return this.resultMessage(command, { ...value, duplicate });
  }

  /** 幂等执行；请求指纹冲突时返回稳定错误码。 */
  private async idempotent(
    command: CommandMessage,
  ): Promise<{ value: DispatchPayload; duplicate: boolean }> {
    try {
      return await this.idempotency.execute(toIdentity(command), () =>
        this.dispatch(command),
      );
    } catch (error: unknown) {
      if (error instanceof AgentError) {
        return {
          value: {
            status: 'error',
            error: {
              code: error.code,
              message: error.code,
              retryable: error.retryable,
            },
          },
          duplicate: false,
        };
      }
      return { value: errorPayload('INTERNAL_ERROR'), duplicate: false };
    }
  }

  private async dispatch(command: CommandMessage): Promise<DispatchPayload> {
    try {
      switch (command.type) {
        case 'session.start': {
          const payload = asRecord(command.payload);
          const workspaceId =
            typeof payload['workspaceId'] === 'string'
              ? payload['workspaceId']
              : 'default';
          const result = await this.operations.startSession(workspaceId);
          return { status: 'ok', data: { ...result } };
        }
        case 'prompt.send': {
          const text = readPrompt(command.payload);
          const sessionId = requireString(command.sessionId, 'SESSION_NOT_FOUND');
          const accepted = await this.operations.sendPrompt(
            sessionId,
            text,
            command.commandId,
          );
          return { status: 'ok', data: { ...accepted } };
        }
        case 'run.cancel': {
          const sessionId = requireString(command.sessionId, 'SESSION_NOT_FOUND');
          const runId = requireString(command.runId, 'RUN_NOT_ACTIVE');
          const accepted = await this.operations.cancelRun(sessionId, runId);
          return { status: 'ok', data: { ...accepted } };
        }
        case 'session.snapshot': {
          const sessionId = requireString(command.sessionId, 'SESSION_NOT_FOUND');
          const snapshot = await this.operations.snapshot(sessionId);
          return { status: 'ok', data: { snapshot } };
        }
        default:
          return errorPayload('UNKNOWN_MESSAGE_TYPE');
      }
    } catch (error: unknown) {
      if (error instanceof AgentError) {
        return {
          status: 'error',
          error: {
            code: error.code,
            message: error.code,
            retryable: error.retryable,
          },
        };
      }
      return errorPayload('INTERNAL_ERROR');
    }
  }

  private resultMessage(
    command: CommandMessage,
    payload: DispatchPayload & { duplicate: boolean },
  ): CommandResultMessage {
    return {
      protocolVersion: 1,
      messageId: `msg_${randomBase64Url(MESSAGE_ID_BYTES)}`,
      timestamp: Date.now(),
      type: 'command.result',
      commandId: command.commandId,
      traceId: command.traceId,
      payload: payload as CommandResultPayload,
    };
  }

  private errorResult(
    message: unknown,
    code: string,
    retryable: boolean,
  ): CommandResultMessage {
    const record = asRecord(message);
    return {
      protocolVersion: 1,
      messageId: `msg_${randomBase64Url(MESSAGE_ID_BYTES)}`,
      timestamp: Date.now(),
      type: 'command.result',
      commandId:
        typeof record['commandId'] === 'string' ? record['commandId'] : '',
      traceId: typeof record['traceId'] === 'string' ? record['traceId'] : '',
      payload: {
        status: 'error',
        duplicate: false,
        error: { code, message: code, retryable },
      },
    };
  }
}

function readPrompt(payload: unknown): string {
  const text = asRecord(payload)['text'];
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new AgentError('INVALID_MESSAGE');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
    throw new AgentError('INVALID_MESSAGE');
  }
  return text;
}

function requireString(value: unknown, code: 'SESSION_NOT_FOUND' | 'RUN_NOT_ACTIVE'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentError(code);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  return value as Record<string, unknown>;
}

function errorPayload(code: string): DispatchPayload {
  return {
    status: 'error',
    error: { code, message: code, retryable: false },
  };
}

function toIdentity(command: CommandMessage): CommandIdentity {
  return {
    commandId: command.commandId,
    type: command.type,
    ...(command.workspaceId === undefined
      ? {}
      : { workspaceId: command.workspaceId }),
    ...(command.sessionId === undefined
      ? {}
      : { sessionId: command.sessionId }),
    ...(command.runId === undefined ? {} : { runId: command.runId }),
    payload: toJsonObject(command.payload),
  };
}

/** 已通过 schema 校验的对象载荷；非对象按空对象处理。 */
function toJsonObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}