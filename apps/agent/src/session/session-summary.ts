import {
  RunStatus,
  SessionLifecycle,
  SessionRecord,
  SessionStatus,
} from '../domain/types.js';

/** 会话列表返回的摘要；不含 prompt、rootPath 或事件正文。 */
export interface SessionSummary {
  sessionId: string;
  workspaceId: string;
  title: string;
  claudeSessionId: string | null;
  status: SessionStatus;
  activeRunId: string | null;
  queuedCount: number;
  pendingApprovalCount: number;
  createdAt: number;
  lastActivityAt: number;
}

/** 按 spec §7.2 计算会话公开状态。 */
export function computeSessionStatus(record: SessionRecord): SessionStatus {
  return computeStatus(
    record.lifecycle,
    record.activeRun !== null,
    record.queue.length,
    record.activeRun?.status ?? null,
  );
}

/** 由 lifecycle、活跃 run、队列长度与活跃 run 状态派生状态。 */
export function computeStatus(
  lifecycle: SessionLifecycle,
  hasActiveRun: boolean,
  queuedCount: number,
  activeRunStatus: RunStatus | null = null,
): SessionStatus {
  if (lifecycle === 'archived') return 'archived';
  if (hasActiveRun) {
    return activeRunStatus === 'waiting_approval' ? 'waiting_approval' : 'running';
  }
  if (queuedCount > 0) return 'queued';
  return 'idle';
}

/** 从记录生成公开摘要。 */
export function toSessionSummary(record: SessionRecord): SessionSummary {
  return {
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    title: record.title,
    claudeSessionId: record.claudeSessionId,
    status: computeSessionStatus(record),
    activeRunId: record.activeRun?.runId ?? null,
    queuedCount: record.queue.length,
    pendingApprovalCount: record.activeRun?.pendingApprovalCount ?? 0,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
  };
}