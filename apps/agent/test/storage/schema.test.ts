import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentDatabase } from '../../src/storage/database.js';

function tempDatabase(): AgentDatabase {
  const dir = mkdtempSync(join(tmpdir(), 's04-schema-'));
  return AgentDatabase.open(join(dir, 'agent.sqlite3'));
}

function objects(db: AgentDatabase): Map<string, string> {
  const rows = db.connection
    .prepare('SELECT name, type FROM sqlite_master')
    .all() as { name: string; type: string }[];
  return new Map(rows.map((row) => [row.name, row.type]));
}

describe('S04 initial schema', () => {
  it('creates every table and unique index with schemaVersion 1', () => {
    const db = tempDatabase();
    try {
      const names = objects(db);
      for (const table of [
        'schema_meta',
        'migration_sources',
        'devices',
        'workspaces',
        'sessions',
        'runs',
        'events',
        'approvals',
        'commands',
        'snapshots',
        'snapshot_pages',
        'audit_logs',
        'scheduler_meta',
      ]) {
        expect(names.get(table), table).toBe('table');
      }
      expect(db.connection.pragma('user_version', { simple: true })).toBe(1);
      const meta = db.connection
        .prepare('SELECT schemaVersion, migrationState FROM schema_meta')
        .get() as { schemaVersion: number; migrationState: string };
      expect(meta).toEqual({ schemaVersion: 1, migrationState: 'absent' });
    } finally {
      db.close();
    }
  });

  it('enforces unique event, command, approval, snapshot and claude session keys', () => {
    const db = tempDatabase();
    try {
      db.immediate((tx) => {
        tx.prepare(
          "INSERT INTO workspaces (workspaceId, displayName, rootPath, createdAt) VALUES ('ws_1','W','/tmp/ws_1',1)",
        ).run();
        tx.prepare(
          "INSERT INTO sessions (sessionId, workspaceId, title, lifecycle, status, createdAt, lastActivityAt) VALUES ('s1','ws_1','T','active','idle',1,1)",
        ).run();
        tx.prepare(
          "INSERT INTO sessions (sessionId, workspaceId, title, lifecycle, status, claudeSessionId, createdAt, lastActivityAt) VALUES ('s2','ws_1','T','active','idle','claude_1',1,1)",
        ).run();
        tx.prepare(
          "INSERT INTO events (eventId, sessionId, seq, type, payloadJson, timestamp) VALUES ('e1','s1',1,'x','{}',1)",
        ).run();
        tx.prepare(
          "INSERT INTO commands (commandId, actorDeviceId, kind, fingerprint, createdAt) VALUES ('c1','device_1','mutating','f',1)",
        ).run();
        tx.prepare(
          "INSERT INTO approvals (approvalId, requestKey, requestFingerprint, workspaceId, sessionId, runId, deviceId, toolUseID, toolName, status, createdAt, expiresAt) VALUES ('a1','rk1','f','ws_1','s1','r1','d1','tu1','Bash','pending',1,2)",
        ).run();
        tx.prepare(
          "INSERT INTO snapshots (snapshotId, sessionId, lastSeq, pageCount, byteLength, sha256, reason, createdAt) VALUES ('snap1','s1',1,1,1,'h','sync',1)",
        ).run();
        tx.prepare(
          "INSERT INTO snapshot_pages (snapshotId, pageIndex, payloadJson) VALUES ('snap1',0,'{}')",
        ).run();
      });

      expect(() =>
        db.immediate((tx) =>
          tx
            .prepare(
              "INSERT INTO events (eventId, sessionId, seq, type, payloadJson, timestamp) VALUES ('e2','s1',1,'x','{}',1)",
            )
            .run(),
        ),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.immediate((tx) =>
          tx
            .prepare(
              "INSERT INTO events (eventId, sessionId, seq, type, payloadJson, timestamp) VALUES ('e1','s1',2,'x','{}',1)",
            )
            .run(),
        ),
      ).toThrow(/UNIQUE|PRIMARY/);
      expect(() =>
        db.immediate((tx) =>
          tx
            .prepare(
              "INSERT INTO commands (commandId, actorDeviceId, kind, fingerprint, createdAt) VALUES ('c1','device_1','mutating','f2',1)",
            )
            .run(),
        ),
      ).toThrow(/UNIQUE|PRIMARY/);
      expect(() =>
        db.immediate((tx) =>
          tx
            .prepare(
              "INSERT INTO approvals (approvalId, requestKey, requestFingerprint, workspaceId, sessionId, runId, deviceId, toolUseID, toolName, status, createdAt, expiresAt) VALUES ('a2','rk1','f','ws_1','s1','r1','d1','tu1','Bash','pending',1,2)",
            )
            .run(),
        ),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.immediate((tx) =>
          tx
            .prepare(
              "INSERT INTO snapshot_pages (snapshotId, pageIndex, payloadJson) VALUES ('snap1',0,'{}')",
            )
            .run(),
        ),
      ).toThrow(/UNIQUE|PRIMARY/);
      expect(() =>
        db.immediate((tx) =>
          tx
            .prepare(
              "INSERT INTO sessions (sessionId, workspaceId, title, lifecycle, status, claudeSessionId, createdAt, lastActivityAt) VALUES ('s3','ws_1','T','active','idle','claude_1',1,1)",
            )
            .run(),
        ),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it('enforces foreign keys and keeps lastSeq in step with events', () => {
    const db = tempDatabase();
    try {
      expect(() =>
        db.immediate((tx) =>
          tx
            .prepare(
              "INSERT INTO sessions (sessionId, workspaceId, title, lifecycle, status, createdAt, lastActivityAt) VALUES ('s1','missing','T','active','idle',1,1)",
            )
            .run(),
        ),
      ).toThrow(/FOREIGN KEY/);

      db.immediate((tx) => {
        tx.prepare(
          "INSERT INTO workspaces (workspaceId, displayName, rootPath, createdAt) VALUES ('ws_1','W','/tmp/ws_1',1)",
        ).run();
        tx.prepare(
          "INSERT INTO sessions (sessionId, workspaceId, title, lifecycle, status, createdAt, lastActivityAt) VALUES ('s1','ws_1','T','active','idle',1,1)",
        ).run();
      });
      expect(() =>
        db.immediate((tx) =>
          tx.prepare("UPDATE sessions SET lastSeq = 5 WHERE sessionId = 's1'").run(),
        ),
      ).toThrow(/lastSeq/);

      db.immediate((tx) => {
        tx.prepare(
          "INSERT INTO events (eventId, sessionId, seq, type, payloadJson, timestamp) VALUES ('e1','s1',1,'x','{}',1)",
        ).run();
        tx.prepare("UPDATE sessions SET lastSeq = 1 WHERE sessionId = 's1'").run();
      });
      expect(
        db.connection
          .prepare("SELECT lastSeq FROM sessions WHERE sessionId = 's1'")
          .get(),
      ).toEqual({ lastSeq: 1 });
    } finally {
      db.close();
    }
  });

  it('reopens the same database without recreating schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 's04-schema-'));
    const path = join(dir, 'agent.sqlite3');
    const first = AgentDatabase.open(path);
    first.immediate((tx) =>
      tx
        .prepare(
          "INSERT INTO workspaces (workspaceId, displayName, rootPath, createdAt) VALUES ('ws_1','W','/tmp/ws_1',1)",
        )
        .run(),
    );
    first.close();

    const second = AgentDatabase.open(path);
    try {
      expect(
        second.connection
          .prepare('SELECT count(*) AS total FROM workspaces')
          .get(),
      ).toEqual({ total: 1 });
    } finally {
      second.close();
    }
  });
});