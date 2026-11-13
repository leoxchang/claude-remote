import { DurableEventJournal } from '../events/durable-event-journal.js';
import { AgentError } from '../command/errors.js';
import { RunRepository } from './repositories/run-repository.js';
import { SessionRepository } from './repositories/session-repository.js';
import { ApprovalRepository } from './repositories/approval-repository.js';
import { SqliteTransaction, UnitOfWork } from './unit-of-work.js';

/** 启动修复结果；计数不含终态记录。 */
export interface RecoveryReport {
  agentInstanceId: string;
  recoveredQueuedRuns: string[];
  interruptedRuns: string[];
  invalidatedApprovals: string[];
}

export interface StartupRecoveryDeps {
  uow: UnitOfWork;
  journal: DurableEventJournal;
  runs: RunRepository;
  sessions: SessionRepository;
  approvals: ApprovalRepository;
  now?: () => number;
}

const ACTIVE_STATUSES: readonly string[] = [
  'starting',
  'running',
  'waiting_approval',
  'cancelling',
];

/**
 * 启动修复：单个 immediate 事务内把旧活跃/queued/pending 修成安全状态。
 *
 * 不自动重放、不自动 allow；每个修复事件占用目标 session 的下一个 seq。
 */
export class StartupRecovery {
  private readonly now: () => number;

  constructor(private readonly deps: StartupRecoveryDeps) {
    this.now = deps.now ?? Date.now;
  }

  repair(input: { agentInstanceId: string; now?: number }): RecoveryReport {
    const now = input.now ?? this.now();
    const report: RecoveryReport = {
      agentInstanceId: input.agentInstanceId,
      recoveredQueuedRuns: [],
      interruptedRuns: [],
      invalidatedApprovals: [],
    };
    try {
      this.deps.uow.immediate((tx) => {
        for (const run of this.deps.runs.listByStatus('queued')) {
          const generation = run.recoveryGeneration + 1;
          this.deps.runs.update({
            ...run,
            status: 'recovery_required',
            recoveryGeneration: generation,
            recoveryReason: 'agent_shutdown',
            startedAt: null,
            endedAt: null,
            errorSummary: null,
          });
          this.deps.journal.appendWithin(tx, {
            sessionId: run.sessionId,
            type: 'run.recovery_required',
            payload: { recoveryGeneration: generation, reason: 'agent_shutdown' },
            runId: run.runId,
          });
          report.recoveredQueuedRuns.push(run.runId);
        }

        for (const status of ACTIVE_STATUSES) {
          for (const run of this.deps.runs.listByStatus(status)) {
            this.deps.runs.update({
              ...run,
              status: 'interrupted',
              promptText: null,
              pendingApprovalCount: 0,
              outcomeUnknown: true,
              eventTailMayBeIncomplete: true,
              recoveryReason: 'agent_shutdown',
              endedAt: now,
              errorSummary: null,
            });
            this.deps.journal.appendWithin(tx, {
              sessionId: run.sessionId,
              type: 'run.completed',
              payload: {
                status: 'interrupted',
                reason: 'agent_shutdown',
                outcomeUnknown: true,
                eventTailMayBeIncomplete: true,
              },
              runId: run.runId,
            });
            report.interruptedRuns.push(run.runId);
            this.markSessionIdle(run.sessionId);
          }
        }

        for (const approval of this.deps.approvals.allPending()) {
          this.deps.approvals.markTerminalWithin(tx, {
            approvalId: approval.approvalId,
            status: 'invalidated',
            resolutionReason: 'agent_shutdown',
            resolvedAt: now,
            responseCommandId: null,
          });
          this.deps.journal.appendWithin(tx, {
            sessionId: approval.sessionId,
            runId: approval.runId,
            approvalId: approval.approvalId,
            type: 'permission.resolved',
            payload: {
              status: 'invalidated',
              resolvedAt: now,
              resolutionReason: 'agent_shutdown',
              responseCommandId: null,
            },
          });
          report.invalidatedApprovals.push(approval.approvalId);
        }

        tx.prepare(
          `INSERT INTO scheduler_meta (key, value) VALUES ('agentInstanceId', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(input.agentInstanceId);
      });
    } catch (error: unknown) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('STORAGE_UNAVAILABLE');
    }
    return report;
  }

  private markSessionIdle(sessionId: string): void {
    const session = this.deps.sessions.get(sessionId);
    if (session === undefined) return;
    this.deps.sessions.update({
      ...session,
      status: 'idle',
      lastActivityAt: this.now(),
    });
  }
}