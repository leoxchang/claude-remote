import { UnitOfWork } from '../unit-of-work.js';
import { SqliteTransaction } from '../unit-of-work.js';

/** 命令来源；设备命令与本地 CLI 互斥。 */
export type CommandActor =
  | { kind: 'device'; deviceId: string }
  | { kind: 'local'; actor: 'local_cli' };

/** 命令类别；只读结果可过期，副作用结果永久保留。 */
export type CommandKind = 'mutating' | 'read_only';

/** commands 表的一行。 */
export interface StoredCommand {
  commandId: string;
  actorDeviceId: string | null;
  localActor: string | null;
  kind: CommandKind;
  fingerprint: string;
  resultJson: string | null;
  resultExpired: boolean;
  createdAt: number;
  completedAt: number | null;
}

export interface NewCommand {
  commandId: string;
  actor: CommandActor;
  kind: CommandKind;
  fingerprint: string;
  resultJson: string;
  createdAt: number;
}

interface CommandRow {
  commandId: string;
  actorDeviceId: string | null;
  localActor: string | null;
  kind: CommandKind;
  fingerprint: string;
  resultJson: string | null;
  resultExpired: number;
  createdAt: number;
  completedAt: number | null;
}

/** 只读首次结果的保留期。 */
export const READ_ONLY_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 命令结果与幂等指纹；原始请求 payload 永不入库。 */
export class CommandRepository {
  constructor(private readonly uow: UnitOfWork) {}

  getWithin(
    tx: SqliteTransaction,
    commandId: string,
  ): StoredCommand | undefined {
    const row = tx
      .prepare(
        `SELECT commandId, actorDeviceId, localActor, kind, fingerprint,
                resultJson, resultExpired, createdAt, completedAt
         FROM commands WHERE commandId = ?`,
      )
      .get(commandId) as CommandRow | undefined;
    return row === undefined ? undefined : toStored(row);
  }

  insertWithin(tx: SqliteTransaction, command: NewCommand): void {
    const actorDeviceId =
      command.actor.kind === 'device' ? command.actor.deviceId : null;
    const localActor =
      command.actor.kind === 'local' ? command.actor.actor : null;
    tx.prepare(
      `INSERT INTO commands
         (commandId, actorDeviceId, localActor, kind, fingerprint,
          resultJson, resultExpired, createdAt, completedAt)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      command.commandId,
      actorDeviceId,
      localActor,
      command.kind,
      command.fingerprint,
      command.resultJson,
      command.createdAt,
      command.createdAt,
    );
  }

  /** 7 天后只清只读 resultJson，保留永久墓碑；返回清理条数。 */
  expireReadOnlyResults(now: number): number {
    return this.uow.immediate((tx) => {
      const result = tx
        .prepare(
          `UPDATE commands
           SET resultJson = NULL, resultExpired = 1
           WHERE kind = 'read_only'
             AND resultExpired = 0
             AND completedAt IS NOT NULL
             AND completedAt <= ?`,
        )
        .run(now - READ_ONLY_RESULT_TTL_MS);
      return result.changes;
    });
  }
}

function toStored(row: CommandRow): StoredCommand {
  return {
    commandId: row.commandId,
    actorDeviceId: row.actorDeviceId,
    localActor: row.localActor,
    kind: row.kind,
    fingerprint: row.fingerprint,
    resultJson: row.resultJson,
    resultExpired: row.resultExpired === 1,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}