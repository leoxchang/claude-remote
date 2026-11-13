import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentDatabase } from '../../src/storage/database.js';

function tempPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 's04-db-'));
  return { dir, path: join(dir, 'agent.sqlite3') };
}

describe('AgentDatabase', () => {
  it('applies fixed pragmas and keeps DB/WAL/SHM at 0600', () => {
    const { dir, path } = tempPath();
    const db = AgentDatabase.open(path);
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      db.immediate((tx) => {
        tx.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, body BLOB)');
        tx.prepare('INSERT INTO probe (body) VALUES (?)').run(
          Buffer.alloc(64 * 1024),
        );
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      for (const suffix of ['-wal', '-shm']) {
        expect(existsSync(`${path}${suffix}`), suffix).toBe(true);
        expect(statSync(`${path}${suffix}`).mode & 0o777).toBe(0o600);
      }
      expect(db.connection.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.connection.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.connection.pragma('synchronous', { simple: true })).toBe(2);
      expect(db.connection.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(db.connection.pragma('wal_autocheckpoint', { simple: true })).toBe(
        1000,
      );
      expect(db.connection.pragma('integrity_check', { simple: true })).toBe(
        'ok',
      );
    } finally {
      db.close();
    }
  });

  it('returns synchronously and rejects async or nested transactions', () => {
    const { path } = tempPath();
    const db = AgentDatabase.open(path);
    try {
      expect(db.read(() => 7)).toBe(7);
      expect(db.immediate(() => 8)).toBe(8);
      expect(() => db.immediate(() => db.immediate(() => 1))).toThrow(
        /STORAGE_TRANSACTION_NESTED/,
      );
      expect(() => db.immediate(async () => 1)).toThrow(
        /STORAGE_TRANSACTION_ASYNC/,
      );
      expect(() => db.read(async () => 1)).toThrow(
        /STORAGE_TRANSACTION_ASYNC/,
      );
      db.immediate((tx) => {
        tx.exec('CREATE TABLE rollback_probe (id TEXT PRIMARY KEY)');
      });
      expect(() =>
        db.immediate((tx) => {
          tx.prepare('INSERT INTO rollback_probe (id) VALUES (?)').run('x');
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(
        db.connection
          .prepare('SELECT count(*) AS total FROM rollback_probe')
          .get(),
      ).toEqual({ total: 0 });
    } finally {
      db.close();
    }
  });

  it('backs up live WAL outside transactions and sets 0600', async () => {
    const { dir, path } = tempPath();
    const db = AgentDatabase.open(path);
    try {
      db.immediate((tx) => {
        tx.exec('CREATE TABLE backup_probe (id INTEGER PRIMARY KEY)');
        const insert = tx.prepare('INSERT INTO backup_probe (id) VALUES (?)');
        for (let index = 0; index < 100; index += 1) insert.run(index);
      });
      const destination = join(dir, 'backup.sqlite3');
      await db.backup(destination);
      expect(statSync(destination).mode & 0o777).toBe(0o600);
      const backup = AgentDatabase.open(destination);
      try {
        expect(
          backup.connection
            .prepare('SELECT count(*) AS total FROM backup_probe')
            .get(),
        ).toEqual({ total: 100 });
      } finally {
        backup.close();
      }
    } finally {
      db.close();
    }
  });

  it('reports live bytes from live pages plus WAL, not the file length', () => {
    const { path } = tempPath();
    const db = AgentDatabase.open(path);
    try {
      db.immediate((tx) => {
        tx.exec('CREATE TABLE bytes_probe (id INTEGER PRIMARY KEY, body BLOB)');
        tx.prepare('INSERT INTO bytes_probe (body) VALUES (?)').run(
          Buffer.alloc(1024 * 1024),
        );
      });
      const allocated = db.liveBytes();
      expect(allocated).toBeGreaterThan(0);
      db.immediate((tx) => tx.exec('DELETE FROM bytes_probe'));
      db.connection.pragma('wal_checkpoint(TRUNCATE)');
      const afterDelete = db.liveBytes();
      expect(afterDelete).toBeLessThan(allocated);
      expect(afterDelete).toBeLessThan(statSync(path).size);
    } finally {
      db.close();
    }
  });
});