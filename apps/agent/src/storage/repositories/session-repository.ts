import { SqliteTransaction, UnitOfWork } from '../unit-of-work.js';

/** sessions 表的权威记录；不含内存 run 索引。 */
export interface StoredSession {
  sessionId: string;
  workspaceId: string;
  claudeSessionId: string | null;
  title: string;
  lifecycle: 'active' | 'archived';
  status: string;
  lastSeq: number;
  retentionFloor: number;
  createdAt: number;
  lastActivityAt: number;
  archivedAt: number | null;
}

interface SessionRow {
  sessionId: string;
  workspaceId: string;
  claudeSessionId: string | null;
  title: string;
  lifecycle: 'active' | 'archived';
  status: string;
  lastSeq: number;
  retentionFloor: number;
  createdAt: number;
  lastActivityAt: number;
  archivedAt: number | null;
}

/** 会话仓库；lastSeq 由事件日志推进，触发器拒绝无事件的前进。 */
export class SessionRepository {
  constructor(private readonly uow: UnitOfWork) {}

  create(record: StoredSession): void {
    this.write((tx) =>
      tx
        .prepare(
          `INSERT INTO sessions
             (sessionId, workspaceId, claudeSessionId, title, lifecycle, status,
              lastSeq, retentionFloor, createdAt, lastActivityAt, archivedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.sessionId,
          record.workspaceId,
          record.claudeSessionId,
          record.title,
          record.lifecycle,
          record.status,
          record.lastSeq,
          record.retentionFloor,
          record.createdAt,
          record.lastActivityAt,
          record.archivedAt,
        ),
    );
  }

  get(sessionId: string): StoredSession | undefined {
    const row = this.uow.connectionRef
      .prepare(
        `SELECT sessionId, workspaceId, claudeSessionId, title, lifecycle, status,
                lastSeq, retentionFloor, createdAt, lastActivityAt, archivedAt
         FROM sessions WHERE sessionId = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    return row === undefined ? undefined : { ...row };
  }

  update(record: StoredSession): void {
    this.write((tx) =>
      tx
        .prepare(
          `UPDATE sessions
           SET workspaceId = ?, claudeSessionId = ?, title = ?, lifecycle = ?,
               status = ?, lastSeq = ?, retentionFloor = ?, createdAt = ?,
               lastActivityAt = ?, archivedAt = ?
           WHERE sessionId = ?`,
        )
        .run(
          record.workspaceId,
          record.claudeSessionId,
          record.title,
          record.lifecycle,
          record.status,
          record.lastSeq,
          record.retentionFloor,
          record.createdAt,
          record.lastActivityAt,
          record.archivedAt,
          record.sessionId,
        ),
    );
  }

  private write<T>(fn: (tx: SqliteTransaction) => T): T {
    if (this.uow.inTransaction) return fn(this.uow.connectionRef);
    return this.uow.immediate(fn);
  }
}