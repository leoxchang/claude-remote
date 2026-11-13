import {
  canonicalRequestFingerprint,
  CommandIdentity,
} from '../command/canonical-request.js';
import { AgentError } from '../command/errors.js';
import { TimelineEvent } from '../events/adapter-events.js';
import { JsonObject } from '../domain/types.js';
import {
  CommandActor,
  CommandKind,
  CommandRepository,
} from './repositories/command-repository.js';
import { SqliteTransaction, UnitOfWork } from './unit-of-work.js';

/** 在事务内追加一条事件并返回持久事件对象。 */
export type AppendEvent = (input: {
  sessionId: string;
  type: string;
  payload: JsonObject;
  runId?: string;
  approvalId?: string;
  eventId?: string;
}) => TimelineEvent;

/** 事件写入与 commit 后发布的端口；Task 5 提供持久实现。 */
export interface EventAppender {
  for(tx: SqliteTransaction): AppendEvent;
  publishCommitted(events: readonly TimelineEvent[]): void;
}

export interface CommandExecution<T> {
  result: T;
  duplicate: boolean;
  events: TimelineEvent[];
}

export interface ExecuteInput<T> {
  identity: CommandIdentity;
  actor: CommandActor;
  kind: CommandKind;
  now: number;
  business: (tx: SqliteTransaction, append: AppendEvent) => T;
}

export interface PersistentCommandExecutorOptions {
  uow: UnitOfWork;
  appender: EventAppender;
}

/**
 * 命令的唯一事务边界。
 *
 * 查重、业务、事件、首次结果同事务提交；commit 后才发布事件。
 * duplicate 不重复执行业务，也不重发领域事件。
 */
export class PersistentCommandExecutor {
  private readonly uow: UnitOfWork;
  private readonly appender: EventAppender;
  readonly commands: CommandRepository;

  constructor(options: PersistentCommandExecutorOptions) {
    this.uow = options.uow;
    this.appender = options.appender;
    this.commands = new CommandRepository(options.uow);
  }

  execute<T>(input: ExecuteInput<T>): CommandExecution<T> {
    const fingerprint = canonicalRequestFingerprint(input.identity);
    const events: TimelineEvent[] = [];
    const execution = this.uow.immediate((tx) =>
      this.runWithin(tx, input, fingerprint, events),
    );
    if (!execution.duplicate) {
      try {
        this.appender.publishCommitted(execution.events);
      } catch {
        // 发布失败只影响当前连接；事件已持久化，可由 afterSeq 补拉。
      }
    }
    return execution;
  }

  private runWithin<T>(
    tx: SqliteTransaction,
    input: ExecuteInput<T>,
    fingerprint: string,
    events: TimelineEvent[],
  ): CommandExecution<T> {
    const existing = this.commands.getWithin(tx, input.identity.commandId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new AgentError('COMMAND_ID_CONFLICT');
      }
      if (existing.resultJson === null) {
        throw new AgentError(
          existing.resultExpired
            ? 'COMMAND_RESULT_EXPIRED'
            : 'STORAGE_UNAVAILABLE',
        );
      }
      return {
        result: parseResult<T>(existing.resultJson),
        duplicate: true,
        events: [],
      };
    }

    const append = this.appender.for(tx);
    const collect: AppendEvent = (event) => {
      const stored = append(event);
      events.push(stored);
      return stored;
    };
    const result = input.business(tx, collect);
    if (isPromiseLike(result)) {
      throw new AgentError('STORAGE_TRANSACTION_ASYNC');
    }
    const resultJson = serializeResult(result);
    this.commands.insertWithin(tx, {
      commandId: input.identity.commandId,
      actor: input.actor,
      kind: input.kind,
      fingerprint,
      resultJson,
      createdAt: input.now,
    });
    return { result, duplicate: false, events };
  }
}

function serializeResult(result: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new AgentError('STORAGE_UNAVAILABLE');
  }
  if (serialized === undefined) {
    throw new AgentError('STORAGE_UNAVAILABLE');
  }
  return serialized;
}

function parseResult<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new AgentError('STORAGE_CORRUPT');
  }
}

function isPromiseLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}