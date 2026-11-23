import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import {
  hashPassword,
  hashToken,
  newDeviceToken,
  newPrefixedId,
  tokenMatches,
  verifyPasswordHash,
} from '../security/credentials.js';
import { DEFAULT_LIMITS } from '../limits.js';
import {
  AccountRecord,
  CreateDeviceInput,
  DeviceRecord,
  RelayStore,
  StoreError,
} from './store.js';

const DB_FILE_NAME = 'relay.sqlite';
const SCHEMA_VERSION = 1;

interface AccountRow {
  account_id: string;
  username: string;
  password_hash: string;
  disabled: number;
  created_at: number;
}

interface DeviceRow {
  device_id: string;
  account_id: string;
  role: string;
  device_name: string;
  platform: string;
  app_version: string;
  token_hash: string;
  revoked: number;
  created_at: number;
  last_seen_at: number | null;
  connection_epoch: number;
}

const SCHEMA_SQL = `
CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  role TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  connection_epoch INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX devices_account ON devices(account_id);
`;

const UNIQUE_VIOLATION = 'SQLITE_CONSTRAINT_UNIQUE';

/** 打开（必要时创建）data 目录下的 SQLite 注册表；maxDevices 仅测试用。 */
export function openRelayStore(
  dataDir: string,
  maxDevices: number = DEFAULT_LIMITS.maxDevicesPerAccount,
): RelayStore {
  mkdirSync(dataDir, { recursive: true });
  return new SqliteRelayStore(join(dataDir, DB_FILE_NAME), maxDevices);
}

class SqliteRelayStore implements RelayStore {
  private readonly db: Database.Database;

  constructor(
    file: string,
    private readonly maxDevices: number,
  ) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  createAccount(username: string, password: string): AccountRecord {
    const accountId = newPrefixedId('acc_');
    try {
      this.db
        .prepare(
          `INSERT INTO accounts (account_id, username, password_hash, disabled, created_at)
           VALUES (?, ?, ?, 0, ?)`,
        )
        .run(accountId, username, hashPassword(password), Date.now());
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new StoreError('USERNAME_TAKEN');
      throw error;
    }
    const created = this.findAccountByUsername(username);
    if (created === null) throw new Error('ACCOUNT_NOT_FOUND');
    return created;
  }

  findAccountByUsername(username: string): AccountRecord | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE username = ?')
      .get(username) as AccountRow | undefined;
    return row === undefined ? null : toAccountRecord(row);
  }

  verifyPassword(username: string, password: string): AccountRecord | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE username = ?')
      .get(username) as AccountRow | undefined;
    if (row === undefined || !verifyPasswordHash(password, row.password_hash)) {
      return null;
    }
    return toAccountRecord(row);
  }

  setPassword(username: string, password: string): void {
    this.updateAccount(
      'UPDATE accounts SET password_hash = ? WHERE username = ?',
      username,
      hashPassword(password),
    );
  }

  setAccountDisabled(username: string, disabled: boolean): void {
    this.updateAccount(
      'UPDATE accounts SET disabled = ? WHERE username = ?',
      username,
      disabled ? 1 : 0,
    );
  }

  listAccounts(): AccountRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY created_at')
      .all() as AccountRow[];
    return rows.map(toAccountRecord);
  }

  createDevice(input: CreateDeviceInput): {
    device: DeviceRecord;
    deviceToken: string;
  } {
    const deviceToken = newDeviceToken();
    const insert = this.db.transaction((): string => {
      const account = this.db
        .prepare('SELECT account_id FROM accounts WHERE account_id = ?')
        .get(input.accountId) as { account_id: string } | undefined;
      if (account === undefined) throw new StoreError('ACCOUNT_NOT_FOUND');
      const active = this.db
        .prepare(
          'SELECT COUNT(*) AS count FROM devices WHERE account_id = ? AND revoked = 0',
        )
        .get(input.accountId) as { count: number };
      if (active.count >= this.maxDevices) {
        throw new StoreError('DEVICE_LIMIT_REACHED');
      }
      const deviceId = newPrefixedId('dev_');
      this.db
        .prepare(
          `INSERT INTO devices
             (device_id, account_id, role, device_name, platform, app_version,
              token_hash, revoked, created_at, last_seen_at, connection_epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, 0)`,
        )
        .run(
          deviceId,
          input.accountId,
          input.role,
          input.deviceName,
          input.platform,
          input.appVersion,
          hashToken(deviceToken),
          Date.now(),
        );
      return deviceId;
    });
    const deviceId = insert();
    const device = this.findDevice(deviceId);
    if (device === null) throw new Error('DEVICE_NOT_FOUND');
    return { device, deviceToken };
  }

  verifyDevice(deviceId: string, token: string): DeviceRecord | null {
    const row = this.db
      .prepare(
        `SELECT d.*, a.disabled AS account_disabled
           FROM devices d JOIN accounts a ON a.account_id = d.account_id
          WHERE d.device_id = ?`,
      )
      .get(deviceId) as (DeviceRow & { account_disabled: number }) | undefined;
    if (row === undefined || row.revoked !== 0 || row.account_disabled !== 0) {
      return null;
    }
    if (!tokenMatches(token, row.token_hash)) return null;
    return toDeviceRecord(row);
  }

  findDevice(deviceId: string): DeviceRecord | null {
    const row = this.db
      .prepare('SELECT * FROM devices WHERE device_id = ?')
      .get(deviceId) as DeviceRow | undefined;
    return row === undefined ? null : toDeviceRecord(row);
  }

  listDevices(accountId: string): DeviceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM devices WHERE account_id = ? ORDER BY created_at')
      .all(accountId) as DeviceRow[];
    return rows.map(toDeviceRecord);
  }

  revokeDevice(accountId: string, deviceId: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE devices SET revoked = 1 WHERE device_id = ? AND account_id = ?',
      )
      .run(deviceId, accountId);
    return result.changes > 0;
  }

  nextConnectionEpoch(deviceId: string): number {
    const row = this.db
      .prepare(
        `UPDATE devices SET connection_epoch = connection_epoch + 1
          WHERE device_id = ? RETURNING connection_epoch`,
      )
      .get(deviceId) as { connection_epoch: number } | undefined;
    if (row === undefined) throw new Error('DEVICE_NOT_FOUND');
    return row.connection_epoch;
  }

  touchLastSeen(deviceId: string): void {
    this.db
      .prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?')
      .run(Date.now(), deviceId);
  }

  close(): void {
    this.db.close();
  }

  private updateAccount(
    sql: string,
    username: string,
    value: string | number,
  ): void {
    const result = this.db.prepare(sql).run(value, username);
    if (result.changes === 0) throw new StoreError('ACCOUNT_NOT_FOUND');
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version >= SCHEMA_VERSION) return;
    this.db.exec(SCHEMA_SQL);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

function toAccountRecord(row: AccountRow): AccountRecord {
  return {
    accountId: row.account_id,
    username: row.username,
    disabled: row.disabled !== 0,
    createdAt: row.created_at,
  };
}

function toDeviceRecord(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.device_id,
    accountId: row.account_id,
    role: row.role === 'desktop' ? 'desktop' : 'phone',
    deviceName: row.device_name,
    platform: row.platform,
    appVersion: row.app_version,
    revoked: row.revoked !== 0,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    connectionEpoch: row.connection_epoch,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}