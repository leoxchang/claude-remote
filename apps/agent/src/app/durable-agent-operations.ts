import { AgentError } from '../command/errors.js';
import { AttachmentRequest } from '../attachment/attachment-store.js';
import { defaultSessionTitle } from '../session/session-title.js';
import {
  SessionListInput,
  SessionPage,
} from '../session/session-list.js';
import { SessionSummary } from '../session/session-summary.js';
import { DurableApprovalStore } from '../approval/durable-approval-store.js';
import { DurablePermissionBroker } from '../approval/durable-permission-broker.js';
import { toApprovalSummary } from '../approval/approval-summary.js';
import { approvalContentDescriptor } from '../approval/approval-content.js';
import {
  ApprovalSummary,
  PermissionResponseInput,
  PermissionResponseResult,
} from '../approval/approval-types.js';
import { DurableEventJournal } from '../events/durable-event-journal.js';
import { randomBase64Url } from '../security/random.js';
import { MAX_ACTIVE_RUNS, MAX_GLOBAL_QUEUED_RUNS } from '../run/run-limits.js';
import { PromptAccepted } from '../run/run-scheduler.js';
import { PromptAdmission } from '../run/prompt-admission.js';
import { DurableRunController } from '../run/durable-run-controller.js';
import { DurableRunScheduler } from '../run/durable-run-scheduler.js';
import { RunRepository, StoredRun } from '../storage/repositories/run-repository.js';
import {
  SessionRepository,
  StoredSession,
} from '../storage/repositories/session-repository.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import {
  AgentOperations,
  WorkspaceListResult,
} from './agent-operations.js';

const SESSION_ID_BYTES = 12;
const MAX_SESSIONS_PER_PAGE = 100;

export interface DurableAgentOperationsDeps {
  workspaces: WorkspaceManager;
  sessions: SessionRepository;
  runs: RunRepository;
  scheduler: DurableRunScheduler;
  controller: DurableRunController;
  admission: PromptAdmission;
  broker: DurablePermissionBroker;
  approvals: DurableApprovalStore;
  journal: DurableEventJournal;
  now?: () => number;
  generateSessionId?: () => string;
}

/**
 * S04 运行时命令操作：项目/会话/run/审批全部以 SQLite 为权威。
 *
 * 快照与增量同步在 Task 12 接入；在此之前明确返回 RESYNC_REQUIRED。
 */
export class DurableAgentOperations implements AgentOperations {
  private readonly now: () => number;
  private readonly generateSessionId: () => string;

  constructor(private readonly deps: DurableAgentOperationsDeps) {
    this.now = deps.now ?? Date.now;
    this.generateSessionId =
      deps.generateSessionId ??
      (() => `session_${randomBase64Url(SESSION_ID_BYTES)}`);
  }

  listWorkspaces(): WorkspaceListResult {
    return {
      workspaces: this.deps.workspaces.list(),
      scheduler: {
        maxActiveRuns: MAX_ACTIVE_RUNS,
        activeRunCount: this.deps.scheduler.activeCount(),
        queuedRunCount: this.deps.scheduler.queuedRunCount(),
        maxQueuedRuns: MAX_GLOBAL_QUEUED_RUNS,
        pendingApprovalCount: this.deps.approvals.globalPendingCount(),
      },
    };
  }

  createSession(workspaceId: string, title?: string): SessionSummary {
    this.deps.workspaces.assertUsable(workspaceId);
    const now = this.now();
    const session: StoredSession = {
      sessionId: this.generateSessionId(),
      workspaceId,
      claudeSessionId: null,
      title: title ?? defaultSessionTitle(new Date(now)),
      lifecycle: 'active',
      status: 'idle',
      lastSeq: 0,
      retentionFloor: 0,
      createdAt: now,
      lastActivityAt: now,
      archivedAt: null,
    };
    this.deps.journal.commit((tx, append) => {
      this.deps.sessions.create(session);
      append({
        sessionId: session.sessionId,
        type: 'session.status',
        payload: {
          state: 'idle',
          title: session.title,
          workspaceId,
          createdAt: now,
        },
      });
    });
    return this.summary(session);
  }

  listSessions(input: SessionListInput): SessionPage {
    this.deps.workspaces.assertUsable(input.workspaceId);
    const rows = this.deps.sessions
      .listByWorkspace(input.workspaceId, input.includeArchived === true)
      .slice(0, Math.min(input.limit ?? MAX_SESSIONS_PER_PAGE, MAX_SESSIONS_PER_PAGE));
    return {
      sessions: rows.map((session) => this.summary(session)),
      nextCursor: null,
    };
  }

  resumeSession(sessionId: string): SessionSummary {
    const session = this.requireSession(sessionId);
    this.deps.workspaces.assertUsable(session.workspaceId);
    return this.summary(session);
  }

  renameSession(sessionId: string, title: string): SessionSummary {
    const session = this.requireSession(sessionId);
    if (title.trim().length === 0) throw new AgentError('INVALID_MESSAGE');
    const updated: StoredSession = { ...session, title };
    this.deps.journal.commit((tx, append) => {
      this.deps.sessions.update(updated);
      append({
        sessionId,
        type: 'session.status',
        payload: { state: 'idle', title },
      });
    });
    return this.summary(updated);
  }

  archiveSession(sessionId: string): SessionSummary {
    const session = this.requireSession(sessionId);
    if (
      this.deps.runs.countBySessionStatus(sessionId, 'queued') > 0 ||
      this.deps.runs.listByStatus('recovery_required').some(
        (run) => run.sessionId === sessionId,
      ) ||
      this.activeRun(sessionId) !== undefined
    ) {
      throw new AgentError('SESSION_BUSY');
    }
    const updated: StoredSession = {
      ...session,
      lifecycle: 'archived',
      status: 'archived',
      archivedAt: this.now(),
    };
    this.deps.journal.commit((tx, append) => {
      this.deps.sessions.update(updated);
      append({
        sessionId,
        type: 'session.status',
        payload: { state: 'archived' },
      });
    });
    return this.summary(updated);
  }

  startSession(workspaceId: string): SessionSummary {
    this.deps.workspaces.assertUsable(workspaceId);
    const sessions = this.deps.sessions.listByWorkspace(workspaceId, false);
    if (sessions.length === 1) return this.summary(sessions[0] as StoredSession);
    if (sessions.length === 0) return this.createSession(workspaceId);
    throw new AgentError('SESSION_SELECTION_REQUIRED');
  }

  sendPrompt(
    workspaceId: string | undefined,
    sessionId: string,
    text: string,
    commandId: string,
    traceId: string,
    deviceId: string,
    attachments: readonly AttachmentRequest[] = [],
  ): Promise<PromptAccepted> {
    const execution = this.deps.admission.send({
      identity: {
        commandId,
        type: 'prompt.send',
        ...(workspaceId === undefined ? {} : { workspaceId }),
        sessionId,
        payload: {
          text,
          ...(attachments.length === 0
            ? {}
            : {
                attachments: attachments.map((attachment) => ({
                  attachmentId: attachment.attachmentId,
                  mediaType: attachment.mediaType,
                  size: attachment.size,
                })),
              }),
        },
      },
      actor: { deviceId },
      text,
      attachmentCount: attachments.length,
      traceId,
      now: this.now(),
    });
    this.deps.scheduler.drain();
    return Promise.resolve(execution.result);
  }

  cancelRun(sessionId: string, runId: string): Promise<{
    sessionId: string;
    runId: string;
    status: 'cancelling';
  }> {
    const run = this.deps.runs.get(runId);
    if (run === undefined) return Promise.reject(new AgentError('RUN_NOT_FOUND'));
    if (run.sessionId !== sessionId) {
      return Promise.reject(new AgentError('RUN_SESSION_MISMATCH'));
    }
    return this.deps.controller.cancel(runId);
  }

  removeQueuedRun(sessionId: string, runId: string): Promise<{
    sessionId: string;
    runId: string;
    status: 'cancelled';
    removed: true;
  }> {
    const run = this.deps.runs.get(runId);
    if (run === undefined) return Promise.reject(new AgentError('RUN_NOT_FOUND'));
    if (run.sessionId !== sessionId) {
      return Promise.reject(new AgentError('RUN_SESSION_MISMATCH'));
    }
    try {
      return Promise.resolve(this.deps.scheduler.removeQueued(runId));
    } catch (error: unknown) {
      return Promise.reject(error);
    }
  }

  snapshot(sessionId: string): Promise<never> {
    this.requireSession(sessionId);
    return Promise.reject(new AgentError('RESYNC_REQUIRED'));
  }

  respondPermission(
    input: PermissionResponseInput,
  ): PermissionResponseResult {
    return this.deps.broker.respond(input);
  }

  pendingApprovals(sessionId: string): ApprovalSummary[] {
    return this.deps.approvals
      .pendingForSession(sessionId)
      .flatMap((record) =>
        record.content === null
          ? []
          : [
              toApprovalSummary(
                record,
                approvalContentDescriptor(record.content),
              ),
            ],
      );
  }

  activeCount(): number {
    return this.deps.scheduler.activeCount();
  }

  queuedRunCount(): number {
    return this.deps.scheduler.queuedRunCount();
  }

  private requireSession(sessionId: string): StoredSession {
    const session = this.deps.sessions.get(sessionId);
    if (session === undefined) throw new AgentError('SESSION_NOT_FOUND');
    return session;
  }

  private activeRun(sessionId: string): StoredRun | undefined {
    return this.deps.runs
      .listByStatus('starting')
      .concat(this.deps.runs.listByStatus('running'))
      .concat(this.deps.runs.listByStatus('waiting_approval'))
      .concat(this.deps.runs.listByStatus('cancelling'))
      .find((run) => run.sessionId === sessionId);
  }

  private summary(session: StoredSession): SessionSummary {
    const active = this.activeRun(session.sessionId);
    const queuedCount = this.deps.runs.countBySessionStatus(
      session.sessionId,
      'queued',
    );
    return {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      title: session.title,
      claudeSessionId: session.claudeSessionId,
      status:
        session.lifecycle === 'archived'
          ? 'archived'
          : active !== undefined
            ? active.status === 'waiting_approval'
              ? 'waiting_approval'
              : 'running'
            : queuedCount > 0
              ? 'queued'
              : 'idle',
      activeRunId: active?.runId ?? null,
      queuedCount,
      pendingApprovalCount: active?.pendingApprovalCount ?? 0,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      model: session.model ?? null,
    };
  }
}