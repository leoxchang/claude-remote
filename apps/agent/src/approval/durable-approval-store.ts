import { AgentError } from '../command/errors.js';
import { DurableEventJournal } from '../events/durable-event-journal.js';
import {
  ApprovalAuditRecord,
  ApprovalRecord,
  ApprovalStatus,
  ApprovalSummary,
  ResolutionReason,
} from './approval-types.js';
import {
  ApprovalRepository,
  StoredApproval,
} from '../storage/repositories/approval-repository.js';
import { UnitOfWork } from '../storage/unit-of-work.js';
import {
  VolatileApprovalEntry,
  VolatileApprovalRegistry,
} from './volatile-approval-registry.js';

export interface DurableTerminalCommit {
  approvalId: string;
  status: Exclude<ApprovalStatus, 'pending'>;
  resolutionReason: ResolutionReason;
  resolvedAt: number;
  responseCommandId: string | null;
}

/**
 * 审批安全记录（DB）与正文（内存）的组合。
 *
 * requested/resolved 事件与审批行同事务提交，commit 后才发布；
 * 正文、原始输入与 Promise 只存在 VolatileApprovalRegistry。
 */
export class DurableApprovalStore {
  readonly volatile = new VolatileApprovalRegistry();
  private readonly repository: ApprovalRepository;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly journal: DurableEventJournal,
  ) {
    this.repository = new ApprovalRepository(uow);
  }

  /** 先注册内存正文；DB 成功前不得对外可见。 */
  registerPending(record: ApprovalRecord, entry: VolatileApprovalEntry): void {
    if (record.status !== 'pending') {
      throw new Error('only pending approvals can be registered');
    }
    this.volatile.register(record.approvalId, entry);
  }

  /** 单事务写审批行与 permission.requested，commit 后发布。 */
  commitRequested(record: ApprovalRecord, summary: ApprovalSummary): void {
    this.journal.commit((tx, append) => {
      this.repository.insertWithin(tx, record, summary.content);
      append({
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
    });
  }

  /** requested 提交失败时撤销内存正文。 */
  removeUncommitted(approvalId: string): void {
    this.volatile.remove(approvalId);
  }

  getById(approvalId: string): ApprovalRecord | null {
    const stored = this.repository.getById(approvalId);
    return stored === null ? null : this.toRecord(stored);
  }

  getByRequestKey(requestKey: string): ApprovalRecord | null {
    const row = this.uow.connectionRef
      .prepare(
        `SELECT approvalId FROM approvals WHERE requestKey = ?`,
      )
      .get(requestKey) as { approvalId: string } | undefined;
    return row === undefined ? null : this.getById(row.approvalId);
  }

  pendingForRun(runId: string): ApprovalRecord[] {
    return this.repository.pendingWhere('runId', runId).map((row) => this.toRecord(row));
  }

  pendingForSession(sessionId: string): ApprovalRecord[] {
    return this.repository
      .pendingWhere('sessionId', sessionId)
      .map((row) => this.toRecord(row));
  }

  pendingForWorkspace(workspaceId: string): ApprovalRecord[] {
    return this.repository
      .pendingWhere('workspaceId', workspaceId)
      .map((row) => this.toRecord(row));
  }

  pendingForDevice(deviceId: string): ApprovalRecord[] {
    return this.repository
      .pendingWhere('deviceId', deviceId)
      .map((row) => this.toRecord(row));
  }

  pendingCount(runId: string): number {
    return this.repository.countWhere('runId', runId);
  }

  globalPendingCount(): number {
    return this.repository.globalPendingCount();
  }

  allPending(): ApprovalRecord[] {
    return this.repository.allPending().map((row) => this.toRecord(row));
  }

  /** 单事务改终态并写 permission.resolved；失败时抛 STORAGE_UNAVAILABLE。 */
  commitTerminal(
    commit: DurableTerminalCommit,
  ): { previous: ApprovalRecord; current: ApprovalRecord } | null {
    try {
      return this.journal.commit((tx, append) => {
        const previous = this.repository.getWithin(tx, commit.approvalId);
        if (previous === null || previous.status !== 'pending') return null;
        const current = this.repository.markTerminalWithin(tx, commit);
        if (current === null) return null;
        append({
          sessionId: current.sessionId,
          runId: current.runId,
          approvalId: current.approvalId,
          type: 'permission.resolved',
          payload: {
            status: current.status,
            resolvedAt: current.resolvedAt,
            resolutionReason: current.resolutionReason,
            responseCommandId: current.responseCommandId,
          },
        });
        return {
          previous: this.toRecord(previous),
          current: this.toRecord(current),
        };
      }).value;
    } catch {
      throw new AgentError('STORAGE_UNAVAILABLE');
    }
  }

  clearVolatile(approvalId: string): void {
    this.volatile.remove(approvalId);
  }

  audit(approvalId: string): ApprovalAuditRecord | null {
    return this.repository.audit(approvalId);
  }

  /** 供启动修复读取持久 pending。 */
  storedPending(): StoredApproval[] {
    return this.repository.allPending();
  }

  private toRecord(row: StoredApproval): ApprovalRecord {
    return approvalToRecord(row, this.volatile.get(row.approvalId));
  }
}

/** 安全行 + 内存正文组合成 S03 ApprovalRecord 形状。 */
function approvalToRecord(
  row: StoredApproval,
  volatile: VolatileApprovalEntry | null,
): ApprovalRecord {
  return {
    approvalId: row.approvalId,
    requestKey: row.requestKey,
    requestFingerprint: row.requestFingerprint,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    runId: row.runId,
    deviceId: row.deviceId,
    toolUseID: row.toolUseID,
    toolName: row.toolName,
    agentID: row.agentID,
    defaultToNo: row.defaultToNo,
    hasDecisionReason: row.hasDecisionReason,
    hasBlockedPath: row.hasBlockedPath,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt,
    resolutionReason: row.resolutionReason,
    responseCommandId: row.responseCommandId,
    content: volatile?.content ?? null,
    originalInput: volatile?.originalInput ?? null,
    resultPromise: volatile?.resultPromise ?? null,
  };
}