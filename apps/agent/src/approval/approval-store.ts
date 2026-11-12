import {
  ApprovalAuditRecord,
  ApprovalRecord,
  ApprovalStatus,
  ResolutionReason,
} from './approval-types.js';

/** 终态迁移输入；只有 pending 记录可以迁移。 */
export interface TerminalCommit {
  approvalId: string;
  status: Exclude<ApprovalStatus, 'pending'>;
  resolutionReason: ResolutionReason;
  resolvedAt: number;
  responseCommandId: string | null;
}

/**
 * 当前进程内的审批索引。
 *
 * 记录不可变；终态后清除正文、原始输入与 Promise 引用，
 * 只保留安全审计。S04 再持久化，本阶段不写盘。
 */
export class ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly approvalIdByRequestKey = new Map<string, string>();
  private readonly audits = new Map<string, ApprovalAuditRecord>();

  /** 按 approvalId 读取；未知返回 null。 */
  getById(approvalId: string): ApprovalRecord | null {
    return this.records.get(approvalId) ?? null;
  }

  /** 按 runId+requestId 内部键读取。 */
  getByRequestKey(requestKey: string): ApprovalRecord | null {
    const approvalId = this.approvalIdByRequestKey.get(requestKey);
    if (approvalId === undefined) return null;
    return this.records.get(approvalId) ?? null;
  }

  /** 注册 pending；调用方保证容量与去重已在同一同步栈内完成。 */
  registerPending(record: ApprovalRecord): ApprovalRecord {
    if (record.status !== 'pending') {
      throw new Error('only pending approvals can be registered');
    }
    this.records.set(record.approvalId, record);
    this.approvalIdByRequestKey.set(record.requestKey, record.approvalId);
    return record;
  }

  /** requested 发布失败时撤销尚未提交的 pending。 */
  removeUncommitted(approvalId: string): void {
    const record = this.records.get(approvalId);
    if (record === undefined || record.status !== 'pending') return;
    this.records.delete(approvalId);
    this.approvalIdByRequestKey.delete(record.requestKey);
  }

  /** 指定 run 的 pending，按创建顺序。 */
  pendingForRun(runId: string): ApprovalRecord[] {
    return this.pendingWhere((record) => record.runId === runId);
  }

  /** 指定会话的 pending。 */
  pendingForSession(sessionId: string): ApprovalRecord[] {
    return this.pendingWhere((record) => record.sessionId === sessionId);
  }

  /** 指定项目的 pending。 */
  pendingForWorkspace(workspaceId: string): ApprovalRecord[] {
    return this.pendingWhere((record) => record.workspaceId === workspaceId);
  }

  /** 指定设备的 pending。 */
  pendingForDevice(deviceId: string): ApprovalRecord[] {
    return this.pendingWhere((record) => record.deviceId === deviceId);
  }

  /** 指定 run 的 pending 数。 */
  pendingCount(runId: string): number {
    return this.pendingForRun(runId).length;
  }

  /** 全局 pending 数。 */
  globalPendingCount(): number {
    return this.pendingWhere(() => true).length;
  }

  /**
   * 原子终态迁移；只有 pending 能迁移。
   *
   * 返回迁移前后记录，调用方在返回后发布事件并 resolve Promise。
   */
  commitTerminal(
    commit: TerminalCommit,
  ): { previous: ApprovalRecord; current: ApprovalRecord } | null {
    const previous = this.records.get(commit.approvalId);
    if (previous === undefined || previous.status !== 'pending') return null;
    const current: ApprovalRecord = Object.freeze({
      ...previous,
      status: commit.status,
      resolvedAt: commit.resolvedAt,
      resolutionReason: commit.resolutionReason,
      responseCommandId: commit.responseCommandId,
      content: null,
      originalInput: null,
      resultPromise: null,
    });
    this.records.set(commit.approvalId, current);
    this.audits.set(commit.approvalId, {
      approvalId: previous.approvalId,
      workspaceId: previous.workspaceId,
      sessionId: previous.sessionId,
      runId: previous.runId,
      deviceId: previous.deviceId,
      toolUseID: previous.toolUseID,
      toolName: previous.toolName,
      requestFingerprint: previous.requestFingerprint,
      status: current.status,
      createdAt: previous.createdAt,
      resolvedAt: current.resolvedAt,
      resolutionReason: current.resolutionReason,
      contentByteLength: previous.content?.byteLength ?? null,
      contentSha256: previous.content?.sha256 ?? null,
    });
    return { previous, current };
  }

  /** 终态审计副本；未知返回 null。 */
  audit(approvalId: string): ApprovalAuditRecord | null {
    return this.audits.get(approvalId) ?? null;
  }

  private pendingWhere(
    predicate: (record: ApprovalRecord) => boolean,
  ): ApprovalRecord[] {
    const found: ApprovalRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status !== 'pending') continue;
      if (predicate(record)) found.push(record);
    }
    return found;
  }
}