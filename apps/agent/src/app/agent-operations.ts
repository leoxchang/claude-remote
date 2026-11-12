import { AgentError } from '../command/errors.js';
import { SnapshotCoordinator } from '../events/snapshot-coordinator.js';
import {
  MAX_ACTIVE_RUNS,
  MAX_GLOBAL_QUEUED_RUNS,
} from '../run/run-limits.js';
import {
  CancelAccepted,
  PromptAccepted,
  QueueRemoved,
  RunScheduler,
} from '../run/run-scheduler.js';
import { ManagedRunController } from '../run/run-controller.js';
import { SessionListInput, SessionPage } from '../session/session-list.js';
import { SessionRegistry } from '../session/session-registry.js';
import { SessionSnapshotEvent } from '../session/session-controller.js';
import {
  SessionSummary,
  toSessionSummary,
} from '../session/session-summary.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { WorkspaceSummary } from '../workspace/workspace-types.js';

/** 调度器公开摘要；workspace.list 返回。 */
export interface SchedulerSummary {
  maxActiveRuns: number;
  activeRunCount: number;
  queuedRunCount: number;
  maxQueuedRuns: number;
}

/** workspace.list 的结果。 */
export interface WorkspaceListResult {
  workspaces: WorkspaceSummary[];
  scheduler: SchedulerSummary;
}

/** 命令层依赖的全部操作；由运行时实现。 */
export interface AgentOperations {
  listWorkspaces(): WorkspaceListResult;
  createSession(workspaceId: string, title?: string): SessionSummary;
  listSessions(input: SessionListInput): SessionPage;
  resumeSession(sessionId: string): SessionSummary;
  renameSession(sessionId: string, title: string): SessionSummary;
  archiveSession(sessionId: string): SessionSummary;
  /** S01 兼容：零个创建、一个附着、多个要求选择。 */
  startSession(workspaceId: string): SessionSummary;
  sendPrompt(
    workspaceId: string | undefined,
    sessionId: string,
    text: string,
    commandId: string,
    traceId: string,
  ): Promise<PromptAccepted>;
  cancelRun(sessionId: string, runId: string): Promise<CancelAccepted>;
  removeQueuedRun(sessionId: string, runId: string): Promise<QueueRemoved>;
  snapshot(sessionId: string): Promise<SessionSnapshotEvent>;
  activeCount(): number;
  queuedRunCount(): number;
}

/** AgentOperations 的组合实现。 */
export interface AgentOperationsDependencies {
  workspaces: WorkspaceManager;
  sessions: SessionRegistry;
  scheduler: RunScheduler;
  runs: ManagedRunController;
  snapshots: SnapshotCoordinator;
  currentEpoch: () => number;
}

/** 把项目、会话、run 与快照组合成命令层可用的操作。 */
export class AgentOperationsImpl implements AgentOperations {
  constructor(private readonly deps: AgentOperationsDependencies) {}

  listWorkspaces(): WorkspaceListResult {
    return {
      workspaces: this.deps.workspaces.list(),
      scheduler: {
        maxActiveRuns: MAX_ACTIVE_RUNS,
        activeRunCount: this.activeCount(),
        queuedRunCount: this.queuedRunCount(),
        maxQueuedRuns: MAX_GLOBAL_QUEUED_RUNS,
      },
    };
  }

  createSession(workspaceId: string, title?: string): SessionSummary {
    this.deps.workspaces.assertUsable(workspaceId);
    const record = this.deps.sessions.create(
      title === undefined ? { workspaceId } : { workspaceId, title },
    );
    return toSessionSummary(record);
  }

  listSessions(input: SessionListInput): SessionPage {
    this.deps.workspaces.assertUsable(input.workspaceId);
    return this.deps.sessions.listSessions(input);
  }

  resumeSession(sessionId: string): SessionSummary {
    const record = this.deps.sessions.get(sessionId);
    this.deps.workspaces.assertUsable(record.workspaceId);
    return toSessionSummary(record);
  }

  renameSession(sessionId: string, title: string): SessionSummary {
    this.assertSessionUsable(sessionId);
    return this.deps.sessions.rename(sessionId, title);
  }

  archiveSession(sessionId: string): SessionSummary {
    this.assertSessionUsable(sessionId);
    return this.deps.sessions.archive(sessionId);
  }

  startSession(workspaceId: string): SessionSummary {
    this.deps.workspaces.assertUsable(workspaceId);
    return toSessionSummary(this.deps.sessions.startCompatible(workspaceId));
  }

  async sendPrompt(
    workspaceId: string | undefined,
    sessionId: string,
    text: string,
    commandId: string,
    traceId: string,
  ): Promise<PromptAccepted> {
    const session = this.deps.sessions.get(sessionId);
    if (workspaceId !== undefined && workspaceId !== session.workspaceId) {
      throw new AgentError('WORKSPACE_NOT_ALLOWED');
    }
    return this.deps.runs.sendPrompt(sessionId, text, commandId, traceId);
  }

  cancelRun(sessionId: string, runId: string): Promise<CancelAccepted> {
    return this.deps.runs.cancel(sessionId, runId);
  }

  removeQueuedRun(sessionId: string, runId: string): Promise<QueueRemoved> {
    return this.deps.runs.removeQueued(sessionId, runId);
  }

  async snapshot(sessionId: string): Promise<SessionSnapshotEvent> {
    this.assertSessionUsable(sessionId);
    const { snapshot } = await this.deps.snapshots.captureAndSend(
      sessionId,
      this.deps.currentEpoch(),
    );
    return snapshot;
  }

  activeCount(): number {
    return this.deps.scheduler.activeCount();
  }

  queuedRunCount(): number {
    return this.deps.scheduler.queuedRunCount();
  }

  private assertSessionUsable(sessionId: string): void {
    const record = this.deps.sessions.get(sessionId);
    this.deps.workspaces.assertUsable(record.workspaceId);
  }
}