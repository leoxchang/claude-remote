import { SessionRecord, SessionStatus } from '../domain/types.js';

/** 会话列表返回的摘要；不含 prompt、rootPath 或事件正文。 */
export interface SessionSummary {
  sessionId: string;
  workspaceId: string;
  title: string;
  claudeSessionId: string | null;
  status: SessionStatus;
  activeRunId: string | null;
  queuedCount: number;
  createdAt: number;
  lastActivityAt: number;
}

/** 按 spec §7.2 计算会话公开状态。 */
export function computeSessionStatus(record: SessionRecord): SessionStatus {
  if (record.lifecycle === 'archived') return 'archived';
  if (record.activeRun !== null) return 'running';
  if (record.queue.length > 0) return 'queued';
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
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
  };
}