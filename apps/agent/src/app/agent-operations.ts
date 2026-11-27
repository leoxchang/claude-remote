import { AgentError } from '../command/errors.js';
import { AttachmentRequest } from '../attachment/attachment-store.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { pendingApprovalSummaries } from '../approval/approval-summary.js';
import {
  ApprovalSummary,
  PermissionResponseInput,
  PermissionResponseResult,
} from '../approval/approval-types.js';
import { PermissionBroker } from '../approval/permission-broker.js';
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
import { PromptAdmission } from '../run/prompt-admission.js';
import { SessionListInput, SessionPage } from '../session/session-list.js';
import { SessionRegistry } from '../session/session-registry.js';
import { SessionSnapshotEvent } from '../session/session-controller.js';
import {
  SessionSummary,
  toSessionSummary,
} from '../session/session-summary.js';
import {
  ModelCatalogService,
  ModelOption,
} from '../model/model-catalog.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { WorkspaceSummary } from '../workspace/workspace-types.js';

/** 调度器公开摘要；workspace.list 返回。 */
export interface SchedulerSummary {
  maxActiveRuns: number;
  activeRunCount: number;
  queuedRunCount: number;
  maxQueuedRuns: number;
  /** 全局 pending 审批数。 */
  pendingApprovalCount: number;
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
  /** 当前 workspace 可用的模型目录。 */
  listModels(workspaceId: string): Promise<ModelOption[]>;
  /** 设置会话模型；null 表示跟随 Mac 默认。 */
  setSessionModel(sessionId: string, model: string | null): Promise<SessionSummary>;
  /** S01 兼容：零个创建、一个附着、多个要求选择。 */
  startSession(workspaceId: string): SessionSummary;
  sendPrompt(
    workspaceId: string | undefined,
    sessionId: string,
    text: string,
    commandId: string,
    traceId: string,
    deviceId: string,
    attachments?: readonly AttachmentRequest[],
  ): Promise<PromptAccepted>;
  cancelRun(sessionId: string, runId: string): Promise<CancelAccepted>;
  removeQueuedRun(sessionId: string, runId: string): Promise<QueueRemoved>;
  snapshot(sessionId: string): Promise<SessionSnapshotEvent>;
  respondPermission(input: PermissionResponseInput): PermissionResponseResult;
  pendingApprovals(sessionId: string): ApprovalSummary[];
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
  approvalBroker: PermissionBroker;
  approvalStore: ApprovalStore;
  currentEpoch: () => number;
  /** 模型目录服务；models.list 与 session.set-model 校验使用。 */
  models: ModelCatalogService;
  /** S04：存在时 prompt.send 走持久 queued 接受，不再同步启动 driver。 */
  promptAdmission?: PromptAdmission;
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
        pendingApprovalCount: this.deps.approvalStore.globalPendingCount(),
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

  async listModels(workspaceId: string): Promise<ModelOption[]> {
    const workspace = this.deps.workspaces.assertUsable(workspaceId);
    return this.catalog(workspace.rootPath);
  }

  async setSessionModel(
    sessionId: string,
    model: string | null,
  ): Promise<SessionSummary> {
    const record = this.deps.sessions.get(sessionId);
    if (record.lifecycle === 'archived') {
      throw new AgentError('SESSION_ARCHIVED');
    }
    const workspace = this.deps.workspaces.assertUsable(record.workspaceId);
    if (model !== null) {
      const catalog = await this.catalog(workspace.rootPath);
      if (!catalog.some((entry) => entry.value === model)) {
        throw new AgentError('INVALID_MESSAGE');
      }
    }
    const updated = this.deps.sessions.update(sessionId, (current) => ({
      ...current,
      model,
    }));
    return toSessionSummary(updated);
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
    deviceId: string,
    attachments: readonly AttachmentRequest[] = [],
  ): Promise<PromptAccepted> {
    const session = this.deps.sessions.get(sessionId);
    if (workspaceId !== undefined && workspaceId !== session.workspaceId) {
      throw new AgentError('WORKSPACE_NOT_ALLOWED');
    }
    if (attachments.length > 0) {
      // 旧 S01 运行路径没有附件存储，不能静默丢图。
      throw new AgentError('INVALID_MESSAGE');
    }
    const admission = this.deps.promptAdmission;
    if (admission !== undefined) {
      const execution = admission.send({
        identity: {
          commandId,
          type: 'prompt.send',
          ...(workspaceId === undefined ? {} : { workspaceId }),
          sessionId,
          payload: { text },
        },
        actor: { deviceId },
        text,
        traceId,
        now: Date.now(),
      });
      return execution.result;
    }
    return this.deps.runs.sendPrompt(
      sessionId,
      text,
      commandId,
      traceId,
      deviceId,
    );
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

  /** 用户决策；关联 ID 与当前策略由 Broker 再次复核。 */
  respondPermission(
    input: PermissionResponseInput,
  ): PermissionResponseResult {
    return this.deps.approvalBroker.respond(input);
  }

  /** 会话 pending 的安全摘要；不含正文。 */
  pendingApprovals(sessionId: string): ApprovalSummary[] {
    return pendingApprovalSummaries(this.deps.approvalStore, sessionId);
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

  /** 查询目录；目录实现抛出的 AgentError 原样透传，其余按可重试内部错误上报。 */
  private async catalog(cwd: string): Promise<ModelOption[]> {
    try {
      return await this.deps.models.list(cwd);
    } catch (error: unknown) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('INTERNAL_ERROR', 'INTERNAL_ERROR', true);
    }
  }
}