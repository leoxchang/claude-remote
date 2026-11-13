import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const SQLITE_MODULE = require.resolve('better-sqlite3');

const DB_FILE_MODE = 0o600;
const DB_DIR_MODE = 0o700;

const CHILD_SCRIPT = String.raw`
const Database = require(process.env.S04_SQLITE_MODULE);
const scenario = process.env.S04_SCENARIO;
const db = new Database(process.env.S04_DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = FULL');
db.exec('CREATE TABLE IF NOT EXISTS gate_rows (id TEXT PRIMARY KEY, kind TEXT NOT NULL)');
db.prepare('INSERT OR REPLACE INTO gate_rows (id, kind) VALUES (?, ?)').run('committed', 'committed');
require('node:fs').chmodSync(process.env.S04_DB_PATH, 0o600);
if (scenario === 'commit') process.exit(0);
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO gate_rows (id, kind) VALUES (?, ?)').run('uncommitted', 'uncommitted');
process.exit(7);
`;

interface OpenDatabase {
  db: Database.Database;
  path: string;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 's04-store00-'));
  chmodSync(dir, DB_DIR_MODE);
  return dir;
}

function secureFiles(path: string): void {
  chmodSync(path, DB_FILE_MODE);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${path}${suffix}`)) chmodSync(`${path}${suffix}`, DB_FILE_MODE);
  }
}

function openDatabase(path: string): OpenDatabase {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.pragma('wal_autocheckpoint = 1000');
  secureFiles(path);
  const integrity = db.pragma('integrity_check', { simple: true });
  expect(integrity).toBe('ok');
  return { db, path };
}

function runChild(scenario: 'commit' | 'rollback', path: string): number {
  try {
    execFileSync(process.execPath, ['-e', CHILD_SCRIPT], {
      env: {
        ...process.env,
        S04_SQLITE_MODULE: SQLITE_MODULE,
        S04_SCENARIO: scenario,
        S04_DB_PATH: path,
      },
      stdio: 'ignore',
    });
    return 0;
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    return status ?? -1;
  }
}

describe('STORE-00 Mac real SQLite gate', () => {
  it('runs real better-sqlite3 with WAL, FULL, foreign keys and 0600 files', () => {
    const dir = tempDir();
    const path = join(dir, 'agent.sqlite3');
    expect(runChild('commit', path)).toBe(0);

    const { db } = openDatabase(path);
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('synchronous', { simple: true })).toBe(2);
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(1000);
      expect(statSync(path).mode & 0o777).toBe(DB_FILE_MODE);

      db.prepare('INSERT INTO gate_rows (id, kind) VALUES (?, ?)').run(
        'after-reopen',
        'committed',
      );
      secureFiles(path);
      for (const name of readdirSync(dir).filter((entry) =>
        entry.startsWith('agent.sqlite3-'),
      )) {
        expect(statSync(join(dir, name)).mode & 0o777).toBe(DB_FILE_MODE);
      }
    } finally {
      db.close();
    }
  });

  it('rolls back an uncommitted transaction when the process exits', () => {
    const dir = tempDir();
    const path = join(dir, 'agent.sqlite3');
    expect(runChild('rollback', path)).toBe(7);

    const { db } = openDatabase(path);
    try {
      const rows = db
        .prepare('SELECT id FROM gate_rows ORDER BY id')
        .all() as { id: string }[];
      expect(rows.map((row) => row.id)).toEqual(['committed']);
    } finally {
      db.close();
    }
  });

  it('uses BEGIN IMMEDIATE, enforces foreign keys and backs up live WAL', async () => {
    const dir = tempDir();
    const path = join(dir, 'agent.sqlite3');
    const first = openDatabase(path);
    const second = new Database(path);
    try {
      first.db.exec(`
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parentId TEXT NOT NULL REFERENCES parent(id)
        );
        INSERT INTO parent (id) VALUES ('p1');
      `);
      expect(() =>
        first.db
          .prepare('INSERT INTO child (id, parentId) VALUES (?, ?)')
          .run('c1', 'missing'),
      ).toThrow(/FOREIGN KEY/);

      first.db.exec('BEGIN IMMEDIATE');
      let busyCode: string | undefined;
      try {
        second.exec('BEGIN IMMEDIATE');
      } catch (error: unknown) {
        busyCode = (error as { code?: string }).code;
      }
      expect(busyCode).toBe('SQLITE_BUSY');
      first.db.exec('ROLLBACK');

      first.db.pragma('wal_autocheckpoint = 0');
      const insert = first.db.prepare(
        'INSERT INTO child (id, parentId) VALUES (?, ?)',
      );
      for (let index = 0; index < 50; index += 1) {
        insert.run(`c${index}`, 'p1');
      }
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);

      const backupPath = join(dir, 'backup.sqlite3');
      await first.db.backup(backupPath);
      chmodSync(backupPath, DB_FILE_MODE);

      const backup = new Database(backupPath, { readonly: true });
      try {
        expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
        const count = backup
          .prepare('SELECT count(*) AS total FROM child')
          .get() as { total: number };
        expect(count.total).toBe(50);
      } finally {
        backup.close();
      }
      expect(statSync(backupPath).mode & 0o777).toBe(DB_FILE_MODE);
    } finally {
      second.close();
      first.db.close();
    }
  });

  it('creates the config directory with 0700 for database files', () => {
    const dir = tempDir();
    expect(statSync(dir).mode & 0o777).toBe(DB_DIR_MODE);
    mkdirSync(join(dir, 'nested'), { mode: DB_DIR_MODE });
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(DB_DIR_MODE);
  });
});