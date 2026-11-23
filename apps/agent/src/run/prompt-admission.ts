import { CommandIdentity } from '../command/canonical-request.js';
import { AgentError } from '../command/errors.js';
import { PromptAccepted } from '../run/run-scheduler.js';
import { MAX_GLOBAL_QUEUED_RUNS } from '../run/run-limits.js';
import {
  CommandExecution,
  PersistentCommandExecutor,
} from '../storage/persistent-command-executor.js';
import { RunRepository, StoredRun } from '../storage/repositories/run-repository.js';
import { SessionRepository } from '../storage/repositories/session-repository.js';
import { WorkspaceRepository } from '../storage/repositories/workspace-repository.js';
import { nextEnqueueOrder } from './enqueue-order.js';
import { randomBase64Url } from '../security/random.js';
import { StorageHealth } from '../storage/storage-health.js';

/** prompt 正文上限：16 KiB UTF-8。 */
export const MAX_PROMPT_BYTES = 16 * 1024;

/** queued prompt 的保留期：30 天，requeue 不延长。 */
export const PROMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const RUN_ID_BYTES = 9;

export interface PromptAdmissionDeps {
  executor: PersistentCommandExecutor;
  sessions: SessionRepository;
  runs: RunRepository;
  workspaces: WorkspaceRepository;
  generateRunId?: () => string;
  /** commit 后仅通知 Scheduler drain；绝不在这里启动 driver。 */
  onAccepted?: (accepted: PromptAccepted) => void;
  health?: StorageHealth;
}

export interface SendPromptInput {
  identity: CommandIdentity;
  actor: { deviceId: string };
  text: string;
  /** 本次 prompt 附带的图片数量；允许只有图片没有文字。 */
  attachmentCount?: number;
  traceId: string;
  now: number;
}

/**
 * prompt.send 的持久接受边界。
 *
 * 同一事务内重验会话/项目/容量并插入 queued run、run.queued 与首次结果；
 * 首次结果固定 queued，driver 由 Scheduler 单独决定。
 */
export class PromptAdmission {
  private readonly executor: PersistentCommandExecutor;
  private readonly sessions: SessionRepository;
  private readonly runs: RunRepository;
  private readonly workspaces: WorkspaceRepository;
  private readonly generateRunId: () => string;
  private readonly onAccepted: ((accepted: PromptAccepted) => void) | null;
  private readonly health: StorageHealth | null;

  constructor(deps: PromptAdmissionDeps) {
    this.executor = deps.executor;
    this.sessions = deps.sessions;
    this.runs = deps.runs;
    this.workspaces = deps.workspaces;
    this.generateRunId =
      deps.generateRunId ?? (() => `run_${randomBase64Url(RUN_ID_BYTES)}`);
    this.onAccepted = deps.onAccepted ?? null;
    this.health = deps.health ?? null;
  }

  send(input: SendPromptInput): CommandExecution<PromptAccepted> {
    if (this.health !== null && !this.health.isAvailable()) {
      throw new AgentError('STORAGE_LIMITED');
    }
    if (input.identity.type !== 'prompt.send') {
      throw new AgentError('INVALID_MESSAGE');
    }
    const text = input.text;
    const attachmentCount = input.attachmentCount ?? 0;
    if (
      (text.trim().length === 0 && attachmentCount === 0) ||
      Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES
    ) {
      throw new AgentError('INVALID_MESSAGE');
    }
    const sessionId = input.identity.sessionId;
    if (sessionId === undefined || sessionId.length === 0) {
      throw new AgentError('SESSION_NOT_FOUND');
    }

    const execution = this.executor.execute<PromptAccepted>({
      identity: input.identity,
      actor: { kind: 'device', deviceId: input.actor.deviceId },
      kind: 'mutating',
      now: input.now,
      business: (tx, append) => {
        const session = this.sessions.get(sessionId);
        if (session === undefined) throw new AgentError('SESSION_NOT_FOUND');
        if (
          input.identity.workspaceId !== undefined &&
          input.identity.workspaceId !== session.workspaceId
        ) {
          throw new AgentError('WORKSPACE_NOT_ALLOWED');
        }
        if (session.lifecycle === 'archived') {
          throw new AgentError('SESSION_ARCHIVED');
        }
        const workspace = this.workspaces.get(session.workspaceId);
        if (workspace === undefined) {
          throw new AgentError(
            this.workspaces.isRemoved(session.workspaceId)
              ? 'WORKSPACE_NOT_ALLOWED'
              : 'WORKSPACE_NOT_FOUND',
          );
        }
        if (
          this.runs.countBySessionStatus(sessionId, 'queued') >=
          workspace.policy.perSessionQueueLimit
        ) {
          throw new AgentError('QUEUE_FULL', 'QUEUE_FULL', false, {
            scope: 'session',
            limit: workspace.policy.perSessionQueueLimit,
          });
        }
        if (
          this.runs.countByStatus('queued') >= MAX_GLOBAL_QUEUED_RUNS
        ) {
          throw new AgentError('QUEUE_FULL', 'QUEUE_FULL', false, {
            scope: 'global',
            limit: MAX_GLOBAL_QUEUED_RUNS,
          });
        }

        const run: StoredRun = {
          runId: this.generateRunId(),
          sessionId,
          workspaceId: session.workspaceId,
          deviceId: input.actor.deviceId,
          commandId: input.identity.commandId,
          traceId: input.traceId,
          status: 'queued',
          promptText: text,
          promptExpiresAt: input.now + PROMPT_TTL_MS,
          enqueueOrder: nextEnqueueOrder(tx),
          recoveryGeneration: 0,
          pendingApprovalCount: 0,
          outcomeUnknown: false,
          eventTailMayBeIncomplete: false,
          recoveryReason: null,
          enqueuedAt: input.now,
          startedAt: null,
          endedAt: null,
          errorSummary: null,
        };
        this.runs.insert(run);
        append({
          sessionId,
          type: 'run.queued',
          payload: { enqueuedAt: input.now },
          runId: run.runId,
        });
        return { sessionId, runId: run.runId, status: 'queued' };
      },
    });

    if (!execution.duplicate) this.onAccepted?.(execution.result);
    return execution;
  }
}