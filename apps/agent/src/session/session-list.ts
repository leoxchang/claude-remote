import { AgentError } from '../command/errors.js';
import { SessionRecord } from '../domain/types.js';
import { SessionSummary, toSessionSummary } from './session-summary.js';

/** 会话列表默认页大小。 */
export const DEFAULT_SESSION_PAGE_SIZE = 20;

/** 会话列表最大页大小。 */
export const MAX_SESSION_PAGE_SIZE = 50;

/** session.list 的输入。 */
export interface SessionListInput {
  workspaceId: string;
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
}

/** 一页会话摘要。 */
export interface SessionPage {
  sessions: SessionSummary[];
  nextCursor: string | null;
}

interface CursorPayload {
  v: 1;
  workspaceId: string;
  includeArchived: boolean;
  createdAt: number;
  sessionId: string;
}

/** 按 createdAt DESC, sessionId DESC 稳定分页；cursor 绑定查询条件。 */
export function listSessions(
  records: readonly SessionRecord[],
  input: SessionListInput,
): SessionPage {
  const includeArchived = input.includeArchived === true;
  const limit = normalizeLimit(input.limit);
  const cursor =
    input.cursor === undefined
      ? null
      : decodeCursor(input.cursor, input.workspaceId, includeArchived);

  const sorted = records
    .filter(
      (record) =>
        record.workspaceId === input.workspaceId &&
        (includeArchived || record.lifecycle === 'active'),
    )
    .sort(compareDescending);

  const remaining =
    cursor === null
      ? sorted
      : sorted.filter((record) => compareToCursor(record, cursor) > 0);
  const page = remaining.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    remaining.length > limit && last !== undefined
      ? encodeCursor({
          v: 1,
          workspaceId: input.workspaceId,
          includeArchived,
          createdAt: last.createdAt,
          sessionId: last.sessionId,
        })
      : null;

  return { sessions: page.map(toSessionSummary), nextCursor };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SESSION_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AgentError('INVALID_MESSAGE');
  }
  return Math.min(limit, MAX_SESSION_PAGE_SIZE);
}

function compareDescending(left: SessionRecord, right: SessionRecord): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt;
  }
  if (left.sessionId === right.sessionId) return 0;
  return left.sessionId < right.sessionId ? 1 : -1;
}

function compareToCursor(record: SessionRecord, cursor: CursorPayload): number {
  if (record.createdAt !== cursor.createdAt) {
    return cursor.createdAt - record.createdAt;
  }
  if (record.sessionId === cursor.sessionId) return 0;
  return record.sessionId < cursor.sessionId ? 1 : -1;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(
  raw: string,
  workspaceId: string,
  includeArchived: boolean,
): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new AgentError('INVALID_CURSOR');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AgentError('INVALID_CURSOR');
  }
  const cursor = parsed as Record<string, unknown>;
  if (
    cursor['v'] !== 1 ||
    cursor['workspaceId'] !== workspaceId ||
    cursor['includeArchived'] !== includeArchived ||
    typeof cursor['createdAt'] !== 'number' ||
    typeof cursor['sessionId'] !== 'string'
  ) {
    throw new AgentError('INVALID_CURSOR');
  }
  return {
    v: 1,
    workspaceId,
    includeArchived,
    createdAt: cursor['createdAt'],
    sessionId: cursor['sessionId'],
  };
}