import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { AgentError } from '../command/errors.js';
import { SqliteTransaction, UnitOfWork } from './unit-of-work.js';

/** 数据库、WAL、SHM 与备份统一权限。 */
export const DATABASE_FILE_MODE = 0o600;

/** 数据库目录权限。 */
export const DATABASE_DIR_MODE = 0o700;

/** 当前 schema 版本。 */
export const SCHEMA_VERSION = 2;

/** 按版本排序的迁移脚本；migrate() 依序应用 user_version 之后的迁移。 */
const MIGRATIONS: { version: number; url: URL }[] = [
  { version: 1, url: new URL('./migrations/001_initial.sql', import.meta.url) },
  {
    version: 2,
    url: new URL('./migrations/002_session_model.sql', import.meta.url),
  },
];

/**
 * S04 权威 SQLite 数据库。
 *
 * 打开时先建目录/PRAGMA/integrity_check/schema，再交给调用方；
 * 所有写操作经同一个同步 UnitOfWork。
 */
export class AgentDatabase {
  private closed = false;

  private constructor(
    private readonly db: Database.Database,
    private readonly path: string,
  ) {
    this.uow = new UnitOfWork(db);
  }

  /** 当前数据库的同步事务边界。 */
  readonly uow: UnitOfWork;

  /** 供仓库层使用的原始连接；不得绕过 UnitOfWork 写。 */
  get connection(): Database.Database {
    return this.db;
  }

  /** 打开并验证数据库；迁移失败时关闭连接。 */
  static open(path: string): AgentDatabase {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: DATABASE_DIR_MODE });
    secureDirectory(dir);
    const db = new Database(path, { timeout: 5000 });
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('synchronous = FULL');
      db.pragma('busy_timeout = 5000');
      db.pragma('wal_autocheckpoint = 1000');
      const integrity = db.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') {
        throw new AgentError('STORAGE_CORRUPT');
      }
      const database = new AgentDatabase(db, path);
      database.secureFiles();
      database.migrate();
      return database;
    } catch (error: unknown) {
      db.close();
      throw error;
    }
  }

  read<T>(fn: (tx: SqliteTransaction) => T): T {
    return this.uow.read(fn);
  }

  immediate<T>(fn: (tx: SqliteTransaction) => T): T {
    const value = this.uow.immediate(fn);
    this.secureFiles();
    return value;
  }

  /** SQLite backup API；必须在事务外调用并 await。 */
  async backup(destination: string): Promise<void> {
    if (this.uow.inTransaction) {
      throw new AgentError('STORAGE_TRANSACTION_NESTED');
    }
    const destinationDir = dirname(destination);
    mkdirSync(destinationDir, {
      recursive: true,
      mode: DATABASE_DIR_MODE,
    });
    secureDirectory(destinationDir);
    await this.db.backup(destination);
    chmodSync(destination, DATABASE_FILE_MODE);
  }

  /** live pages + WAL 实际占用；不用主文件长度冒充。 */
  liveBytes(): number {
    const pageSize = this.db.pragma('page_size', { simple: true }) as number;
    const pageCount = this.db.pragma('page_count', { simple: true }) as number;
    const freelist = this.db.pragma('freelist_count', { simple: true }) as number;
    const walPath = `${this.path}-wal`;
    const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
    return Math.max(0, pageCount - freelist) * pageSize + walBytes;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** SQLite 不继承 0600；每次打开/提交后显式收紧三个文件。 */
  private secureFiles(): void {
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(file)) chmodSync(file, DATABASE_FILE_MODE);
    }
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      throw new AgentError('STORAGE_MIGRATION_CONFLICT');
    }
    if (version === SCHEMA_VERSION) return;
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue;
      const sql = readFileSync(fileURLToPath(migration.url), 'utf8');
      this.immediate((tx) => {
        tx.exec(sql);
        tx.pragma(`user_version = ${migration.version}`);
        // UPSERT：新库无 schema_meta 行，v1 升级库已有行，两种情况都落当前版本。
        tx.prepare(
          `INSERT INTO schema_meta (id, schemaVersion, desktopId, migrationState, updatedAt)
           VALUES (1, ?, NULL, 'absent', ?)
           ON CONFLICT(id) DO UPDATE
           SET schemaVersion = excluded.schemaVersion, updatedAt = excluded.updatedAt`,
        ).run(migration.version, Date.now());
      });
    }
  }
}

function secureDirectory(dir: string): void {
  const mode = statSync(dir).mode & 0o777;
  if (mode !== DATABASE_DIR_MODE) chmodSync(dir, DATABASE_DIR_MODE);
}