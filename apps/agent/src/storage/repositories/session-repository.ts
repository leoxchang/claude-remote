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
  /** 会话使用的模型；null 表示跟随 Mac 默认。 */
  model?: string | null;
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
  model: string | null;
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
              lastSeq, retentionFloor, createdAt, lastActivityAt, archivedAt, model)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          record.model ?? null,
        ),
    );
  }

  get(sessionId: string): StoredSession | undefined {
    const row = this.uow.connectionRef
      .prepare(
        `SELECT sessionId, workspaceId, claudeSessionId, title, lifecycle, status,
                lastSeq, retentionFloor, createdAt, lastActivityAt, archivedAt, model
         FROM sessions WHERE sessionId = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    return row === undefined
      ? undefined
      : { ...row, model: row.model ?? null };
  }

  /** 全部会话；清理任务使用。 */
  listAll(): StoredSession[] {
    const rows = this.uow.connectionRef
      .prepare(
        `SELECT sessionId, workspaceId, claudeSessionId, title, lifecycle, status,
                lastSeq, retentionFloor, createdAt, lastActivityAt, archivedAt, model
         FROM sessions ORDER BY createdAt`,
      )
      .all() as SessionRow[];
    return rows.map((row) => ({ ...row, model: row.model ?? null }));
  }

  /** 项目下的会话摘要数据；按创建时间倒序。 */
  listByWorkspace(
    workspaceId: string,
    includeArchived: boolean,
  ): StoredSession[] {
    const rows = this.uow.connectionRef
      .prepare(
        `SELECT sessionId, workspaceId, claudeSessionId, title, lifecycle, status,
                lastSeq, retentionFloor, createdAt, lastActivityAt, archivedAt, model
         FROM sessions
         WHERE workspaceId = ? ${includeArchived ? '' : "AND lifecycle = 'active'"}
         ORDER BY createdAt DESC, sessionId DESC`,
      )
      .all(workspaceId) as SessionRow[];
    return rows.map((row) => ({ ...row, model: row.model ?? null }));
  }

  update(record: StoredSession): void {
    this.write((tx) =>
      tx
        .prepare(
          `UPDATE sessions
           SET workspaceId = ?, claudeSessionId = ?, title = ?, lifecycle = ?,
               status = ?, lastSeq = ?, retentionFloor = ?, createdAt = ?,
               lastActivityAt = ?, archivedAt = ?, model = ?
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
          record.model ?? null,
          record.sessionId,
        ),
    );
  }

  /** 只推进 retentionFloor，不动 lastSeq。 */
  updateRetentionFloor(sessionId: string, retentionFloor: number): void {
    this.write((tx) =>
      tx
        .prepare('UPDATE sessions SET retentionFloor = ? WHERE sessionId = ?')
        .run(retentionFloor, sessionId),
    );
  }

  private write<T>(fn: (tx: SqliteTransaction) => T): T {
    if (this.uow.inTransaction) return fn(this.uow.connectionRef);
    return this.uow.immediate(fn);
  }
}