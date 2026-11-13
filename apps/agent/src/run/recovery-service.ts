import { CommandIdentity } from '../command/canonical-request.js';
import { AgentError } from '../command/errors.js';
import { MAX_GLOBAL_QUEUED_RUNS } from './run-limits.js';
import { PromptAccepted } from './run-scheduler.js';
import {
  CommandExecution,
  PersistentCommandExecutor,
} from '../storage/persistent-command-executor.js';
import { RunRepository } from '../storage/repositories/run-repository.js';
import { SessionRepository } from '../storage/repositories/session-repository.js';
import { WorkspaceRepository } from '../storage/repositories/workspace-repository.js';
import { nextEnqueueOrder } from './enqueue-order.js';

export interface RequeueInput {
  identity: CommandIdentity;
  actor: { deviceId: string };
  sessionId: string;
  runId: string;
  expectedRecoveryGeneration: number;
  now: number;
}

export interface RecoveryServiceDeps {
  executor: PersistentCommandExecutor;
  runs: RunRepository;
  sessions: SessionRepository;
  workspaces: WorkspaceRepository;
  onAccepted?: (accepted: PromptAccepted) => void;
}

/**
 * 显式恢复：只接受 recovery_required，且 generation 必须匹配。
 *
 * requeue 不延长 promptExpiresAt，不继承旧审批，排到当前队尾。
 */
export class RecoveryService {
  private readonly executor: PersistentCommandExecutor;
  private readonly runs: RunRepository;
  private readonly sessions: SessionRepository;
  private readonly workspaces: WorkspaceRepository;
  private readonly onAccepted: ((accepted: PromptAccepted) => void) | null;

  constructor(deps: RecoveryServiceDeps) {
    this.executor = deps.executor;
    this.runs = deps.runs;
    this.sessions = deps.sessions;
    this.workspaces = deps.workspaces;
    this.onAccepted = deps.onAccepted ?? null;
  }

  requeue(input: RequeueInput): CommandExecution<PromptAccepted> {
    if (input.identity.type !== 'run.requeue') {
      throw new AgentError('INVALID_MESSAGE');
    }
    const execution = this.executor.execute<PromptAccepted>({
      identity: input.identity,
      actor: { kind: 'device', deviceId: input.actor.deviceId },
      kind: 'mutating',
      now: input.now,
      business: (tx, append) => {
        const run = this.runs.get(input.runId);
        if (run === undefined) throw new AgentError('RUN_NOT_FOUND');
        if (run.sessionId !== input.sessionId) {
          throw new AgentError('RUN_SESSION_MISMATCH');
        }
        if (run.recoveryGeneration !== input.expectedRecoveryGeneration) {
          throw new AgentError('RECOVERY_GENERATION_CONFLICT');
        }
        if (run.status !== 'recovery_required') {
          throw new AgentError('RUN_NOT_RECOVERABLE');
        }
        const session = this.sessions.get(input.sessionId);
        if (session === undefined) throw new AgentError('SESSION_NOT_FOUND');
        if (session.lifecycle === 'archived') {
          throw new AgentError('SESSION_ARCHIVED');
        }
        const workspace = this.workspaces.get(run.workspaceId);
        if (workspace === undefined) {
          throw new AgentError('WORKSPACE_NOT_ALLOWED');
        }
        if (run.promptText === null) {
          throw new AgentError('RUN_NOT_RECOVERABLE');
        }
        if (
          this.runs.countBySessionStatus(input.sessionId, 'queued') >=
          workspace.policy.perSessionQueueLimit
        ) {
          throw new AgentError('QUEUE_FULL', 'QUEUE_FULL', false, {
            scope: 'session',
            limit: workspace.policy.perSessionQueueLimit,
          });
        }
        if (this.runs.countByStatus('queued') >= MAX_GLOBAL_QUEUED_RUNS) {
          throw new AgentError('QUEUE_FULL', 'QUEUE_FULL', false, {
            scope: 'global',
            limit: MAX_GLOBAL_QUEUED_RUNS,
          });
        }

        this.runs.update({
          ...run,
          status: 'queued',
          enqueueOrder: nextEnqueueOrder(tx),
          enqueuedAt: input.now,
          recoveryReason: null,
          outcomeUnknown: false,
          eventTailMayBeIncomplete: false,
          startedAt: null,
          endedAt: null,
          errorSummary: null,
        });
        append({
          sessionId: input.sessionId,
          type: 'run.queued',
          runId: run.runId,
          payload: {
            enqueuedAt: input.now,
            requeued: true,
            recoveryGeneration: run.recoveryGeneration,
            originalEnqueuedAt: run.enqueuedAt,
          },
        });
        return {
          sessionId: input.sessionId,
          runId: run.runId,
          status: 'queued',
        };
      },
    });
    if (!execution.duplicate) this.onAccepted?.(execution.result);
    return execution;
  }
}