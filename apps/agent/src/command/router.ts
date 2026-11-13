import {
  CommandMessage,
  CommandResultMessage,
  CommandResultPayload,
} from '@claude-remote/protocol/types';
import { validateProtocolMessage } from '@claude-remote/protocol/validator';

import { AgentOperations } from '../app/agent-operations.js';
import { RecoveryService } from '../run/recovery-service.js';
import { SessionSyncService } from '../sync/session-sync-service.js';
import { SnapshotService } from '../sync/snapshot-service.js';
import { DeviceRecord, JsonObject } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';
import { SessionListInput } from '../session/session-list.js';
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
  'workspace.list',
  'session.create',
  'session.list',
  'session.resume',
  'session.rename',
  'session.archive',
  'queue.remove',
  'permission.respond',
  'run.requeue',
  'session.sync',
];

/** 命令路由依赖；幂等表可注入以便测试。 */
export interface CommandRouterDependencies {
  operations: AgentOperations;
  idempotency?: InMemoryIdempotency;
  /** S04 同步/快照/恢复服务；未装配时对应类型按未知命令拒绝。 */
  sync?: SessionSyncService;
  snapshots?: SnapshotService;
  recovery?: RecoveryService;
}

type DispatchPayload =
  | { status: 'ok'; data: Record<string, unknown> }
  | {
      status: 'error';
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
    };

/** 先校验信封与载荷，再交给幂等表和 AgentOperations。 */
export class CommandRouter {
  private readonly operations: AgentOperations;
  private readonly idempotency: InMemoryIdempotency;
  private readonly sync: SessionSyncService | undefined;
  private readonly snapshots: SnapshotService | undefined;
  private readonly recovery: RecoveryService | undefined;

  constructor(deps: CommandRouterDependencies) {
    this.operations = deps.operations;
    this.idempotency = deps.idempotency ?? new InMemoryIdempotency();
    this.sync = deps.sync;
    this.snapshots = deps.snapshots;
    this.recovery = deps.recovery;
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

    const { value, duplicate } = await this.idempotent(command, device);
    return this.resultMessage(command, { ...value, duplicate });
  }

  /** 幂等执行；请求指纹冲突时返回稳定错误码。 */
  private async idempotent(
    command: CommandMessage,
    device: DeviceRecord,
  ): Promise<{ value: DispatchPayload; duplicate: boolean }> {
    try {
      return await this.idempotency.execute(toIdentity(command), () =>
        this.dispatch(command, device),
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
              ...(error.details === undefined ? {} : { details: error.details }),
            },
          },
          duplicate: false,
        };
      }
      return { value: errorPayload('INTERNAL_ERROR'), duplicate: false };
    }
  }

  private async dispatch(
    command: CommandMessage,
    device: DeviceRecord,
  ): Promise<DispatchPayload> {
    try {
      switch (command.type) {
        case 'workspace.list':
          return ok(this.operations.listWorkspaces());
        case 'session.start': {
          const workspaceId = requirePayloadString(
            command.payload,
            'workspaceId',
          );
          return ok(this.operations.startSession(workspaceId));
        }
        case 'session.create': {
          const workspaceId = requirePayloadString(
            command.payload,
            'workspaceId',
          );
          const title = optionalPayloadString(command.payload, 'title');
          return ok(
            this.operations.createSession(
              workspaceId,
              title === undefined ? undefined : title,
            ),
          );
        }
        case 'session.list':
          return ok(this.operations.listSessions(readListInput(command.payload)));
        case 'session.resume': {
          const sessionId = requirePayloadString(command.payload, 'sessionId');
          return ok(this.operations.resumeSession(sessionId));
        }
        case 'session.rename': {
          const sessionId = requirePayloadString(command.payload, 'sessionId');
          const title = requirePayloadString(command.payload, 'title');
          return ok(this.operations.renameSession(sessionId, title));
        }
        case 'session.archive': {
          const sessionId = requirePayloadString(command.payload, 'sessionId');
          return ok(this.operations.archiveSession(sessionId));
        }
        case 'prompt.send': {
          const text = readPrompt(command.payload);
          const sessionId = requireString(command.sessionId, 'SESSION_NOT_FOUND');
          const accepted = await this.operations.sendPrompt(
            command.workspaceId,
            sessionId,
            text,
            command.commandId,
            command.traceId,
            device.deviceId,
          );
          return ok(accepted);
        }
        case 'run.cancel': {
          const sessionId = requireString(command.sessionId, 'SESSION_NOT_FOUND');
          const runId = requireString(command.runId, 'RUN_NOT_ACTIVE');
          return ok(await this.operations.cancelRun(sessionId, runId));
        }
        case 'queue.remove': {
          const sessionId = requireString(command.sessionId, 'SESSION_NOT_FOUND');
          const runId = requireString(command.runId, 'RUN_NOT_FOUND');
          return ok(await this.operations.removeQueuedRun(sessionId, runId));
        }
        case 'session.snapshot': {
          const sessionId = requireString(command.sessionId, 'SESSION_NOT_FOUND');
          if (this.snapshots !== undefined) {
            const payload = asRecord(command.payload);
            const snapshotId =
              typeof payload['snapshotId'] === 'string'
                ? payload['snapshotId']
                : undefined;
            const pageIndex =
              typeof payload['pageIndex'] === 'number' &&
              Number.isInteger(payload['pageIndex'])
                ? payload['pageIndex']
                : undefined;
            if (pageIndex !== undefined && pageIndex < 0) {
              return errorPayload('INVALID_MESSAGE');
            }
            const page = this.snapshots.getPage({
              identity: toIdentity(command),
              actor: { deviceId: device.deviceId },
              sessionId,
              ...(snapshotId === undefined ? {} : { snapshotId }),
              ...(pageIndex === undefined ? {} : { pageIndex }),
              now: Date.now(),
            });
            return ok(page.result);
          }
          const snapshot = await this.operations.snapshot(sessionId);
          return ok({ snapshot });
        }
        case 'session.sync': {
          if (this.sync === undefined) {
            return errorPayload('UNKNOWN_MESSAGE_TYPE');
          }
          const sessionId = requireString(command.sessionId, 'SESSION_NOT_FOUND');
          const payload = asRecord(command.payload);
          const afterSeq = payload['afterSeq'];
          if (
            typeof afterSeq !== 'number' ||
            !Number.isInteger(afterSeq) ||
            afterSeq < 0
          ) {
            return errorPayload('INVALID_MESSAGE');
          }
          const rawLimit = payload['limit'];
          const limit =
            rawLimit === undefined
              ? 100
              : typeof rawLimit === 'number' && Number.isInteger(rawLimit)
                ? rawLimit
                : 0;
          if (limit < 1 || limit > 100) return errorPayload('INVALID_MESSAGE');
          const execution = this.sync.sync({
            identity: toIdentity(command),
            actor: { deviceId: device.deviceId },
            sessionId,
            afterSeq,
            limit,
            now: Date.now(),
          });
          if ('resyncRequired' in execution.result) {
            return errorPayload('RESYNC_REQUIRED', {
              snapshot: execution.result.manifest,
            });
          }
          return ok(execution.result);
        }
        case 'run.requeue': {
          if (this.recovery === undefined) {
            return errorPayload('UNKNOWN_MESSAGE_TYPE');
          }
          const sessionId = requireString(command.sessionId, 'SESSION_NOT_FOUND');
          const runId = requireString(command.runId, 'RUN_NOT_FOUND');
          const payload = asRecord(command.payload);
          const generation = payload['expectedRecoveryGeneration'];
          if (
            typeof generation !== 'number' ||
            !Number.isInteger(generation) ||
            generation < 0
          ) {
            return errorPayload('INVALID_MESSAGE');
          }
          const execution = this.recovery.requeue({
            identity: toIdentity(command),
            actor: { deviceId: device.deviceId },
            sessionId,
            runId,
            expectedRecoveryGeneration: generation,
            now: Date.now(),
          });
          return ok(execution.result);
        }
        case 'permission.respond': {
          const sessionId = requireString(command.sessionId, 'SESSION_NOT_FOUND');
          const runId = requireString(command.runId, 'RUN_NOT_ACTIVE');
          const workspaceId = requireString(
            command.workspaceId,
            'WORKSPACE_NOT_FOUND',
          );
          const approvalId = requireString(
            command.approvalId,
            'APPROVAL_NOT_FOUND',
          );
          const decision = requireDecision(command.payload);
          return ok(
            this.operations.respondPermission({
              approvalId,
              workspaceId,
              sessionId,
              runId,
              deviceId: device.deviceId,
              commandId: command.commandId,
              decision,
            }),
          );
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
            ...(error.details === undefined ? {} : { details: error.details }),
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

function ok<T extends object>(data: T): DispatchPayload {
  return { status: 'ok', data: { ...data } as Record<string, unknown> };
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

function readListInput(payload: unknown): SessionListInput {
  const record = asRecord(payload);
  const workspaceId = requirePayloadString(payload, 'workspaceId');
  const includeArchived = record['includeArchived'];
  const limit = record['limit'];
  const cursor = record['cursor'];
  return {
    workspaceId,
    ...(includeArchived === undefined
      ? {}
      : { includeArchived: includeArchived === true }),
    ...(typeof limit === 'number' ? { limit } : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
  };
}

function requirePayloadString(payload: unknown, key: string): string {
  const value = asRecord(payload)[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentError('INVALID_MESSAGE');
  }
  return value;
}

function optionalPayloadString(
  payload: unknown,
  key: string,
): string | undefined {
  const value = asRecord(payload)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireString(
  value: unknown,
  code:
    | 'SESSION_NOT_FOUND'
    | 'RUN_NOT_ACTIVE'
    | 'RUN_NOT_FOUND'
    | 'WORKSPACE_NOT_FOUND'
    | 'APPROVAL_NOT_FOUND',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentError(code);
  }
  return value;
}

/** 只接受 allow_once 或 deny；其他 payload 字段已被 schema 拒绝。 */
function requireDecision(value: unknown): 'allow_once' | 'deny' {
  const decision = asRecord(value)['decision'];
  if (decision !== 'allow_once' && decision !== 'deny') {
    throw new AgentError('INVALID_MESSAGE');
  }
  return decision;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  return value as Record<string, unknown>;
}

function errorPayload(
  code: string,
  details?: Record<string, unknown>,
): DispatchPayload {
  return {
    status: 'error',
    error: {
      code,
      message: code,
      retryable: false,
      ...(details === undefined ? {} : { details }),
    },
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
    ...(command.approvalId === undefined
      ? {}
      : { approvalId: command.approvalId }),
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