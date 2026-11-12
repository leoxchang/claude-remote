import { approvalContentDescriptor } from './approval-content.js';
import { ApprovalStore } from './approval-store.js';
import {
  ApprovalContentDescriptor,
  ApprovalRecord,
  ApprovalSummary,
} from './approval-types.js';

/** 把 pending 记录投影为协议安全摘要；不含正文或原因文本。 */
export function toApprovalSummary(
  record: ApprovalRecord,
  content: ApprovalContentDescriptor,
): ApprovalSummary {
  return {
    approvalId: record.approvalId,
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    runId: record.runId,
    toolUseID: record.toolUseID,
    toolName: record.toolName,
    agentID: record.agentID,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    defaultToNo: record.defaultToNo,
    hasDecisionReason: record.hasDecisionReason,
    hasBlockedPath: record.hasBlockedPath,
    content,
  };
}

/** 会话全部 pending 的安全摘要；记录缺正文时抛安全错误。 */
export function pendingApprovalSummaries(
  store: ApprovalStore,
  sessionId: string,
): ApprovalSummary[] {
  const summaries: ApprovalSummary[] = [];
  for (const record of store.pendingForSession(sessionId)) {
    if (record.content === null) {
      throw new Error('APPROVAL_CONTENT_UNAVAILABLE');
    }
    summaries.push(
      toApprovalSummary(record, approvalContentDescriptor(record.content)),
    );
  }
  return summaries;
}