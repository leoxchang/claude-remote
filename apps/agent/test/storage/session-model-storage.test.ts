import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { SessionRecord } from '../../src/domain/types.js';
import { AgentDatabase } from '../../src/storage/database.js';
import {
  SessionRepository,
  StoredSession,
} from '../../src/storage/repositories/session-repository.js';
import { toSessionSummary } from '../../src/session/session-summary.js';

const INITIAL_SQL_PATH = fileURLToPath(
  new URL('../../src/storage/migrations/001_initial.sql', import.meta.url),
);

function openDatabase(): AgentDatabase {
  const dir = mkdtempSync(join(tmpdir(), 's04-session-model-'));
  return AgentDatabase.open(join(dir, 'agent.sqlite3'));
}

function sessionColumns(db: AgentDatabase): Set<string> {
  const rows = db.connection.pragma('table_info(sessions)') as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

describe('S04 session model storage', () => {
  it('creates the model column and schema version 2 on a fresh database', () => {
    const db = openDatabase();
    try {
      expect(sessionColumns(db).has('model')).toBe(true);
      expect(db.connection.pragma('user_version', { simple: true })).toBe(2);
    } finally {
      db.close();
    }
  });

  it('upgrades a version 1 database in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 's04-session-model-v1-'));
    const path = join(dir, 'agent.sqlite3');
    const legacy = new Database(path);
    legacy.exec(readFileSync(INITIAL_SQL_PATH, 'utf8'));
    legacy.pragma('user_version = 1');
    legacy
      .prepare(
        `INSERT INTO schema_meta (id, schemaVersion, desktopId, migrationState, updatedAt)
         VALUES (1, 1, NULL, 'absent', 1)`,
      )
      .run();
    legacy.close();

    const db = AgentDatabase.open(path);
    try {
      expect(sessionColumns(db).has('model')).toBe(true);
      expect(db.connection.pragma('user_version', { simple: true })).toBe(2);
      const meta = db.connection
        .prepare('SELECT schemaVersion, migrationState, desktopId FROM schema_meta')
        .get() as {
        schemaVersion: number;
        migrationState: string;
        desktopId: string | null;
      };
      expect(meta).toEqual({
        schemaVersion: 2,
        migrationState: 'absent',
        desktopId: null,
      });
    } finally {
      db.close();
    }
  });

  it('round-trips the session model through SessionRepository', () => {
    const db = openDatabase();
    try {
      const sessions = new SessionRepository(db.uow);
      db.immediate((tx) => {
        tx.prepare(
          "INSERT INTO workspaces (workspaceId, displayName, rootPath, createdAt) VALUES ('ws_1','W','/tmp/ws_1',1)",
        ).run();
      });
      const record: StoredSession = {
        sessionId: 's1',
        workspaceId: 'ws_1',
        claudeSessionId: null,
        title: 'One',
        lifecycle: 'active',
        status: 'idle',
        lastSeq: 0,
        retentionFloor: 0,
        createdAt: 1,
        lastActivityAt: 1,
        archivedAt: null,
        model: null,
      };
      sessions.create(record);
      expect(sessions.get('s1')?.model).toBeNull();

      sessions.update({ ...record, model: 'opus' });
      expect(sessions.get('s1')?.model).toBe('opus');
    } finally {
      db.close();
    }
  });

  it('exposes the model in SessionSummary', () => {
    const record: SessionRecord = {
      sessionId: 's1',
      workspaceId: 'ws_1',
      title: 'One',
      claudeSessionId: null,
      lifecycle: 'active',
      status: 'idle',
      createdAt: 1,
      lastActivityAt: 1,
      activeRun: null,
      queue: [],
      runsById: new Map(),
      lastSeq: 0,
      lastRunStatus: null,
      model: 'opus',
    };
    expect(toSessionSummary(record).model).toBe('opus');
  });
});
