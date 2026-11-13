import { WorkspaceRecord } from '../../workspace/workspace-types.js';
import { SqliteTransaction, UnitOfWork } from '../unit-of-work.js';

/** 项目仓库接口；写方法在调用方事务内同步执行。 */
export interface WorkspaceRepository {
  list(): WorkspaceRecord[];
  get(workspaceId: string): WorkspaceRecord | undefined;
  isRemoved(workspaceId: string): boolean;
  insert(record: WorkspaceRecord): void;
  update(record: WorkspaceRecord): void;
  remove(workspaceId: string, now: number): void;
}

interface WorkspaceRow {
  workspaceId: string;
  displayName: string;
  rootPath: string;
  perSessionQueueLimit: number;
  mobileApprovalMode: 'deny' | 'allow_once';
  createdAt: number;
  removedAt: number | null;
}

/** SQLite 项目仓库；rootPath 只留在 Mac DB，不进入公开摘要。 */
export class SqliteWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly uow: UnitOfWork) {}

  list(): WorkspaceRecord[] {
    const rows = this.uow.connectionRef
      .prepare(
        `SELECT workspaceId, displayName, rootPath, perSessionQueueLimit,
                mobileApprovalMode, createdAt, removedAt
         FROM workspaces WHERE removedAt IS NULL ORDER BY createdAt`,
      )
      .all() as WorkspaceRow[];
    return rows.map(toRecord);
  }

  get(workspaceId: string): WorkspaceRecord | undefined {
    const row = this.uow.connectionRef
      .prepare(
        `SELECT workspaceId, displayName, rootPath, perSessionQueueLimit,
                mobileApprovalMode, createdAt, removedAt
         FROM workspaces WHERE workspaceId = ? AND removedAt IS NULL`,
      )
      .get(workspaceId) as WorkspaceRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  isRemoved(workspaceId: string): boolean {
    const row = this.uow.connectionRef
      .prepare('SELECT removedAt FROM workspaces WHERE workspaceId = ?')
      .get(workspaceId) as { removedAt: number | null } | undefined;
    return row !== undefined && row.removedAt !== null;
  }

  insert(record: WorkspaceRecord): void {
    this.write((tx) =>
      tx
        .prepare(
          `INSERT INTO workspaces
             (workspaceId, displayName, rootPath, perSessionQueueLimit,
              mobileApprovalMode, createdAt, removedAt)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          record.workspaceId,
          record.displayName,
          record.rootPath,
          record.policy.perSessionQueueLimit,
          record.policy.mobileApprovalMode,
          record.createdAt,
        ),
    );
  }

  update(record: WorkspaceRecord): void {
    this.write((tx) =>
      tx
        .prepare(
          `UPDATE workspaces
           SET displayName = ?, rootPath = ?, perSessionQueueLimit = ?, mobileApprovalMode = ?
           WHERE workspaceId = ? AND removedAt IS NULL`,
        )
        .run(
          record.displayName,
          record.rootPath,
          record.policy.perSessionQueueLimit,
          record.policy.mobileApprovalMode,
          record.workspaceId,
        ),
    );
  }

  remove(workspaceId: string, now: number): void {
    this.write((tx) =>
      tx
        .prepare(
          'UPDATE workspaces SET removedAt = ? WHERE workspaceId = ? AND removedAt IS NULL',
        )
        .run(now, workspaceId),
    );
  }

  private write<T>(fn: (tx: SqliteTransaction) => T): T {
    if (this.uow.inTransaction) return fn(this.uow.connectionRef);
    return this.uow.immediate(fn);
  }
}

function toRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    workspaceId: row.workspaceId,
    displayName: row.displayName,
    rootPath: row.rootPath,
    createdAt: row.createdAt,
    policy: {
      perSessionQueueLimit: row.perSessionQueueLimit,
      mobileApprovalMode: row.mobileApprovalMode,
    },
  };
}