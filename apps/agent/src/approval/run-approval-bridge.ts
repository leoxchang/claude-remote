import { AgentLogger } from '../app/logger.js';
import { DeviceRecord } from '../domain/types.js';
import { EventJournal } from '../events/journal.js';
import { EventNormalizer } from '../events/normalizer.js';
import {
  ApprovalEventSink,
  ApprovalResolvedNotice,
  ApprovalRuntimePorts,
  ApprovalSafeError,
  ApprovalSummary,
  RunApprovalContext,
  ToolDeniedNotice,
} from './approval-types.js';

/** Scheduler 侧审批端口；RunScheduler 满足该结构。 */
export interface SchedulerApprovalPorts {
  approvalContext(
    runId: string,
  ): { context: RunApprovalContext; acceptingApprovals: boolean } | null;
  setPendingApprovalCount(runId: string, count: number): void;
}

/** 项目策略读取端口；WorkspaceManager 满足该结构。 */
export interface WorkspaceModePort {
  approvalMode(workspaceId: string): 'deny' | 'allow_once';
}

/** 设备读取端口；DeviceStore 满足该结构。 */
export interface DeviceListPort {
  list(): DeviceRecord[];
}

/** 审批事件的组合端口：运行时状态、Journal 与 Normalizer。 */
export interface RunApprovalBridgeOptions {
  scheduler: SchedulerApprovalPorts;
  workspaces: WorkspaceModePort;
  devices: DeviceListPort;
  journal: EventJournal;
  normalizer: EventNormalizer;
  logger?: AgentLogger;
}

/**
 * 把 Broker 端口接到 Scheduler、Journal 与 Normalizer。
 *
 * 所有方法同步；只发布安全字段，正文只留在 ApprovalStore。
 */
export class RunApprovalBridge
  implements ApprovalRuntimePorts, ApprovalEventSink
{
  constructor(private readonly options: RunApprovalBridgeOptions) {}

  runContext(
    runId: string,
  ): { context: RunApprovalContext; acceptingApprovals: boolean } | null {
    return this.options.scheduler.approvalContext(runId);
  }

  workspaceMode(workspaceId: string): 'deny' | 'allow_once' {
    try {
      return this.options.workspaces.approvalMode(workspaceId);
    } catch {
      return 'deny';
    }
  }

  deviceActive(deviceId: string): boolean {
    return this.options.devices
      .list()
      .some((device) => device.deviceId === deviceId && device.revokedAt === null);
  }

  setPendingApprovalCount(runId: string, count: number): void {
    this.options.scheduler.setPendingApprovalCount(runId, count);
  }

  requested(summary: ApprovalSummary): void {
    this.options.journal.append({
      sessionId: summary.sessionId,
      runId: summary.runId,
      approvalId: summary.approvalId,
      type: 'permission.requested',
      payload: {
        workspaceId: summary.workspaceId,
        toolUseID: summary.toolUseID,
        toolName: summary.toolName,
        agentID: summary.agentID,
        createdAt: summary.createdAt,
        expiresAt: summary.expiresAt,
        defaultToNo: summary.defaultToNo,
        hasDecisionReason: summary.hasDecisionReason,
        hasBlockedPath: summary.hasBlockedPath,
        content: {
          encoding: summary.content.encoding,
          byteLength: summary.content.byteLength,
          sha256: summary.content.sha256,
          chunkCount: summary.content.chunkCount,
        },
      },
    });
  }

  resolved(notice: ApprovalResolvedNotice): void {
    this.options.journal.append({
      sessionId: notice.sessionId,
      runId: notice.runId,
      approvalId: notice.approvalId,
      type: 'permission.resolved',
      payload: {
        status: notice.status,
        resolvedAt: notice.resolvedAt,
        resolutionReason: notice.resolutionReason,
        responseCommandId: notice.responseCommandId,
      },
    });
  }

  reportError(error: ApprovalSafeError): void {
    if (error.sessionId === undefined || error.runId === undefined) {
      this.options.logger?.warn('approval.rejected', {
        code: error.code,
        message: error.message,
      });
      return;
    }
    this.options.journal.append({
      sessionId: error.sessionId,
      runId: error.runId,
      type: 'error',
      payload: {
        code: error.code,
        message: error.message,
      },
    });
  }

  toolDenied(notice: ToolDeniedNotice): void {
    this.options.normalizer.consume({
      kind: 'permissionDenied',
      sessionId: notice.sessionId,
      runId: notice.runId,
      ...(notice.toolUseID === undefined ? {} : { toolUseId: notice.toolUseID }),
      toolName: notice.toolName,
      outcome: notice.outcome,
    });
  }
}