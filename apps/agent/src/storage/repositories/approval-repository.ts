import {
  ApprovalAuditRecord,
  ApprovalContentDescriptor,
  ApprovalRecord,
  ApprovalStatus,
  ResolutionReason,
} from '../../approval/approval-types.js';
import { SqliteTransaction, UnitOfWork } from '../unit-of-work.js';

/** approvals 表的安全元数据；不含正文、原始输入或 Promise。 */
export interface StoredApproval {
  approvalId: string;
  requestKey: string;
  requestFingerprint: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  deviceId: string;
  toolUseID: string;
  toolName: string;
  agentID: string | null;
  defaultToNo: boolean;
  hasDecisionReason: boolean;
  hasBlockedPath: boolean;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  resolutionReason: ResolutionReason | null;
  responseCommandId: string | null;
  contentSha256: string | null;
  contentByteLength: number | null;
}

interface ApprovalRow {
  approvalId: string;
  requestKey: string;
  requestFingerprint: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  deviceId: string;
  toolUseID: string;
  toolName: string;
  agentID: string | null;
  defaultToNo: number;
  hasDecisionReason: number;
  hasBlockedPath: number;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  resolutionReason: ResolutionReason | null;
  responseCommandId: string | null;
  contentSha256: string | null;
  contentByteLength: number | null;
}

const COLUMNS = `approvalId, requestKey, requestFingerprint, workspaceId, sessionId,
  runId, deviceId, toolUseID, toolName, agentID, defaultToNo,
  hasDecisionReason, hasBlockedPath, status, createdAt, expiresAt, resolvedAt,
  resolutionReason, responseCommandId, contentSha256, contentByteLength`;

/** 审批安全记录仓库；pending 正文永远不写库。 */
export class ApprovalRepository {
  constructor(private readonly uow: UnitOfWork) {}

  insertWithin(
    tx: SqliteTransaction,
    record: ApprovalRecord,
    content: ApprovalContentDescriptor | null,
  ): void {
    tx.prepare(
      `INSERT INTO approvals (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    ).run(
      record.approvalId,
      record.requestKey,
      record.requestFingerprint,
      record.workspaceId,
      record.sessionId,
      record.runId,
      record.deviceId,
      record.toolUseID,
      record.toolName,
      record.agentID,
      record.defaultToNo ? 1 : 0,
      record.hasDecisionReason ? 1 : 0,
      record.hasBlockedPath ? 1 : 0,
      record.status,
      record.createdAt,
      record.expiresAt,
      content?.sha256 ?? null,
      content?.byteLength ?? null,
    );
  }

  markTerminalWithin(
    tx: SqliteTransaction,
    input: {
      approvalId: string;
      status: Exclude<ApprovalStatus, 'pending'>;
      resolutionReason: ResolutionReason;
      resolvedAt: number;
      responseCommandId: string | null;
    },
  ): StoredApproval | null {
    const previous = this.getWithin(tx, input.approvalId);
    if (previous === null || previous.status !== 'pending') return null;
    tx.prepare(
      `UPDATE approvals
       SET status = ?, resolvedAt = ?, resolutionReason = ?, responseCommandId = ?
       WHERE approvalId = ? AND status = 'pending'`,
    ).run(
      input.status,
      input.resolvedAt,
      input.resolutionReason,
      input.responseCommandId,
      input.approvalId,
    );
    return this.getWithin(tx, input.approvalId);
  }

  getWithin(tx: SqliteTransaction, approvalId: string): StoredApproval | null {
    const row = tx
      .prepare(`SELECT ${COLUMNS} FROM approvals WHERE approvalId = ?`)
      .get(approvalId) as ApprovalRow | undefined;
    return row === undefined ? null : toStored(row);
  }

  getByRequestKeyWithin(
    tx: SqliteTransaction,
    requestKey: string,
  ): StoredApproval | null {
    const row = tx
      .prepare(`SELECT ${COLUMNS} FROM approvals WHERE requestKey = ?`)
      .get(requestKey) as ApprovalRow | undefined;
    return row === undefined ? null : toStored(row);
  }

  pendingWhere(column: 'runId' | 'sessionId' | 'workspaceId' | 'deviceId', value: string): StoredApproval[] {
    const rows = this.uow.connectionRef
      .prepare(
        `SELECT ${COLUMNS} FROM approvals
         WHERE ${column} = ? AND status = 'pending' ORDER BY createdAt`,
      )
      .all(value) as ApprovalRow[];
    return rows.map(toStored);
  }

  allPending(): StoredApproval[] {
    const rows = this.uow.connectionRef
      .prepare(
        `SELECT ${COLUMNS} FROM approvals WHERE status = 'pending' ORDER BY createdAt`,
      )
      .all() as ApprovalRow[];
    return rows.map(toStored);
  }

  countWhere(
    column: 'runId' | 'sessionId' | 'workspaceId' | 'deviceId',
    value: string,
  ): number {
    const row = this.uow.connectionRef
      .prepare(
        `SELECT count(*) AS total FROM approvals WHERE ${column} = ? AND status = 'pending'`,
      )
      .get(value) as { total: number };
    return row.total;
  }

  globalPendingCount(): number {
    const row = this.uow.connectionRef
      .prepare(
        "SELECT count(*) AS total FROM approvals WHERE status = 'pending'",
      )
      .get() as { total: number };
    return row.total;
  }

  audit(approvalId: string): ApprovalAuditRecord | null {
    const stored = this.getById(approvalId);
    if (stored === null) return null;
    return {
      approvalId: stored.approvalId,
      workspaceId: stored.workspaceId,
      sessionId: stored.sessionId,
      runId: stored.runId,
      deviceId: stored.deviceId,
      toolUseID: stored.toolUseID,
      toolName: stored.toolName,
      requestFingerprint: stored.requestFingerprint,
      status: stored.status,
      createdAt: stored.createdAt,
      resolvedAt: stored.resolvedAt,
      resolutionReason: stored.resolutionReason,
      contentByteLength: stored.contentByteLength,
      contentSha256: stored.contentSha256,
    };
  }

  getById(approvalId: string): StoredApproval | null {
    const row = this.uow.connectionRef
      .prepare(`SELECT ${COLUMNS} FROM approvals WHERE approvalId = ?`)
      .get(approvalId) as ApprovalRow | undefined;
    return row === undefined ? null : toStored(row);
  }
}

function toStored(row: ApprovalRow): StoredApproval {
  return {
    ...row,
    defaultToNo: row.defaultToNo === 1,
    hasDecisionReason: row.hasDecisionReason === 1,
    hasBlockedPath: row.hasBlockedPath === 1,
  };
}