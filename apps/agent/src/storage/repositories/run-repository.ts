import { SqliteTransaction, UnitOfWork } from '../unit-of-work.js';

/** runs 表的权威记录；promptText 有保留期且不进入公开摘要。 */
export interface StoredRun {
  runId: string;
  sessionId: string;
  workspaceId: string;
  deviceId: string;
  commandId: string;
  traceId: string;
  status: string;
  promptText: string | null;
  promptExpiresAt: number | null;
  enqueueOrder: number;
  recoveryGeneration: number;
  pendingApprovalCount: number;
  outcomeUnknown: boolean;
  eventTailMayBeIncomplete: boolean;
  recoveryReason: string | null;
  enqueuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  errorSummary: string | null;
}

interface RunRow {
  runId: string;
  sessionId: string;
  workspaceId: string;
  deviceId: string;
  commandId: string;
  traceId: string;
  status: string;
  promptText: string | null;
  promptExpiresAt: number | null;
  enqueueOrder: number;
  recoveryGeneration: number;
  pendingApprovalCount: number;
  outcomeUnknown: number;
  eventTailMayBeIncomplete: number;
  recoveryReason: string | null;
  enqueuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  errorSummary: string | null;
}

const COLUMNS = `runId, sessionId, workspaceId, deviceId, commandId, traceId, status,
  promptText, promptExpiresAt, enqueueOrder, recoveryGeneration,
  pendingApprovalCount, outcomeUnknown, eventTailMayBeIncomplete,
  recoveryReason, enqueuedAt, startedAt, endedAt, errorSummary`;

/** run 仓库；状态变更必须在调用方事务内同步完成。 */
export class RunRepository {
  constructor(private readonly uow: UnitOfWork) {}

  insert(record: StoredRun): void {
    this.write((tx) =>
      tx
        .prepare(
          `INSERT INTO runs (${COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.runId,
          record.sessionId,
          record.workspaceId,
          record.deviceId,
          record.commandId,
          record.traceId,
          record.status,
          record.promptText,
          record.promptExpiresAt,
          record.enqueueOrder,
          record.recoveryGeneration,
          record.pendingApprovalCount,
          record.outcomeUnknown ? 1 : 0,
          record.eventTailMayBeIncomplete ? 1 : 0,
          record.recoveryReason,
          record.enqueuedAt,
          record.startedAt,
          record.endedAt,
          record.errorSummary,
        ),
    );
  }

  get(runId: string): StoredRun | undefined {
    const row = this.uow.connectionRef
      .prepare(`SELECT ${COLUMNS} FROM runs WHERE runId = ?`)
      .get(runId) as RunRow | undefined;
    return row === undefined ? undefined : toStored(row);
  }

  update(record: StoredRun): void {
    this.write((tx) =>
      tx
        .prepare(
          `UPDATE runs SET sessionId = ?, workspaceId = ?, deviceId = ?,
             commandId = ?, traceId = ?, status = ?, promptText = ?,
             promptExpiresAt = ?, enqueueOrder = ?, recoveryGeneration = ?,
             pendingApprovalCount = ?, outcomeUnknown = ?,
             eventTailMayBeIncomplete = ?, recoveryReason = ?, enqueuedAt = ?,
             startedAt = ?, endedAt = ?, errorSummary = ?
           WHERE runId = ?`,
        )
        .run(
          record.sessionId,
          record.workspaceId,
          record.deviceId,
          record.commandId,
          record.traceId,
          record.status,
          record.promptText,
          record.promptExpiresAt,
          record.enqueueOrder,
          record.recoveryGeneration,
          record.pendingApprovalCount,
          record.outcomeUnknown ? 1 : 0,
          record.eventTailMayBeIncomplete ? 1 : 0,
          record.recoveryReason,
          record.enqueuedAt,
          record.startedAt,
          record.endedAt,
          record.errorSummary,
          record.runId,
        ),
    );
  }

  listByStatus(status: string): StoredRun[] {
    const rows = this.uow.connectionRef
      .prepare(
        `SELECT ${COLUMNS} FROM runs WHERE status = ? ORDER BY enqueueOrder, enqueuedAt`,
      )
      .all(status) as RunRow[];
    return rows.map(toStored);
  }

  countByStatus(status: string): number {
    const row = this.uow.connectionRef
      .prepare('SELECT count(*) AS total FROM runs WHERE status = ?')
      .get(status) as { total: number };
    return row.total;
  }

  countBySessionStatus(sessionId: string, status: string): number {
    const row = this.uow.connectionRef
      .prepare(
        'SELECT count(*) AS total FROM runs WHERE sessionId = ? AND status = ?',
      )
      .get(sessionId, status) as { total: number };
    return row.total;
  }

  private write<T>(fn: (tx: SqliteTransaction) => T): T {
    if (this.uow.inTransaction) return fn(this.uow.connectionRef);
    return this.uow.immediate(fn);
  }
}

function toStored(row: RunRow): StoredRun {
  return {
    ...row,
    outcomeUnknown: row.outcomeUnknown === 1,
    eventTailMayBeIncomplete: row.eventTailMayBeIncomplete === 1,
  };
}