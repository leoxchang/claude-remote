import { DeviceRecord } from '../../domain/types.js';
import { safeEqualBase64Url, sha256Base64Url } from '../../security/random.js';
import { SqliteTransaction, UnitOfWork } from '../unit-of-work.js';

interface DeviceRow {
  deviceId: string;
  deviceName: string;
  tokenHash: string;
  status: 'active' | 'revoked';
  createdAt: number;
  revokedAt: number | null;
}

/**
 * SQLite 设备仓库；保持 S01 的 create/verify/revoke/active 语义。
 *
 * 只保存 tokenHash，明文 token 不落库。
 */
export class SqliteDeviceStore {
  constructor(private readonly uow: UnitOfWork) {}

  async create(
    deviceId: string,
    deviceName: string,
    tokenHash: string,
  ): Promise<DeviceRecord> {
    const record: DeviceRecord = {
      deviceId,
      deviceName,
      tokenHash,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.write((tx) => {
      tx.prepare(
        `INSERT INTO devices (deviceId, deviceName, tokenHash, status, createdAt, revokedAt)
         VALUES (?, ?, ?, 'active', ?, NULL)`,
      ).run(
        record.deviceId,
        record.deviceName,
        record.tokenHash,
        Date.parse(record.createdAt),
      );
    });
    return { ...record };
  }

  async verify(deviceId: string, token: string): Promise<DeviceRecord | null> {
    const row = this.connection()
      .prepare(
        'SELECT deviceId, deviceName, tokenHash, status, createdAt, revokedAt FROM devices WHERE deviceId = ? AND revokedAt IS NULL',
      )
      .get(deviceId) as DeviceRow | undefined;
    if (row === undefined) return null;
    if (!safeEqualBase64Url(sha256Base64Url(token), row.tokenHash)) {
      return null;
    }
    return toRecord(row);
  }

  async revoke(deviceId: string): Promise<DeviceRecord> {
    const now = Date.now();
    const changed = this.write((tx) =>
      tx
        .prepare(
          "UPDATE devices SET status = 'revoked', revokedAt = ? WHERE deviceId = ? AND revokedAt IS NULL",
        )
        .run(now, deviceId),
    );
    if (changed.changes === 0) {
      const existing = this.connection()
        .prepare(
          'SELECT deviceId, deviceName, tokenHash, status, createdAt, revokedAt FROM devices WHERE deviceId = ?',
        )
        .get(deviceId) as DeviceRow | undefined;
      if (existing === undefined) {
        throw new Error(`unknown device: ${deviceId}`);
      }
      return toRecord(existing);
    }
    const row = this.connection()
      .prepare(
        'SELECT deviceId, deviceName, tokenHash, status, createdAt, revokedAt FROM devices WHERE deviceId = ?',
      )
      .get(deviceId) as DeviceRow;
    return toRecord(row);
  }

  active(): DeviceRecord | null {
    const row = this.connection()
      .prepare(
        'SELECT deviceId, deviceName, tokenHash, status, createdAt, revokedAt FROM devices WHERE revokedAt IS NULL ORDER BY createdAt LIMIT 1',
      )
      .get() as DeviceRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  list(): DeviceRecord[] {
    const rows = this.connection()
      .prepare(
        'SELECT deviceId, deviceName, tokenHash, status, createdAt, revokedAt FROM devices ORDER BY createdAt',
      )
      .all() as DeviceRow[];
    return rows.map(toRecord);
  }

  private connection() {
    return this.uow.connectionRef;
  }

  private write<T>(fn: (tx: SqliteTransaction) => T): T {
    if (this.uow.inTransaction) return fn(this.connection());
    return this.uow.immediate(fn);
  }
}

function toRecord(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    tokenHash: row.tokenHash,
    createdAt: new Date(row.createdAt).toISOString(),
    revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt).toISOString(),
  };
}