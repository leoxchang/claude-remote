import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

/// RecoveryStore 的 v2 schema；v1 数据全部保留，仅新增 voice_drafts。
const int recoverySchemaVersion = 2;

/// 单个 App 本地数据库；文件位于 Application Support，永不使用 Documents。
final class RecoveryDatabase {
  const RecoveryDatabase._();

  /// 打开或创建 recovery.db；测试可注入 factory 与目录。
  static Future<Database> open({
    DatabaseFactory? factory,
    Future<Directory> Function()? supportDirectory,
  }) async {
    final selectedFactory = factory ?? databaseFactory;
    final directory = await (supportDirectory ?? getApplicationSupportDirectory)();
    await directory.create(recursive: true);
    final path = p.join(directory.path, 'recovery.db');
    return selectedFactory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: recoverySchemaVersion,
        onConfigure: (db) async {
          await db.execute('PRAGMA journal_mode = WAL');
          await db.execute('PRAGMA foreign_keys = ON');
        },
        onCreate: (db, version) async {
          await db.execute('''
            CREATE TABLE outbox_commands (
              commandId TEXT PRIMARY KEY,
              sessionId TEXT NOT NULL,
              type TEXT NOT NULL,
              payloadJson TEXT,
              agentInstanceId TEXT,
              state TEXT NOT NULL,
              createdAt INTEGER NOT NULL,
              updatedAt INTEGER NOT NULL
            )
          ''');
          await db.execute('''
            CREATE UNIQUE INDEX outbox_active_intent
            ON outbox_commands (sessionId)
            WHERE type IN ('prompt.send', 'run.requeue')
              AND state IN ('persisted', 'sending', 'awaiting_ack', 'confirmation_required')
          ''');
          await db.execute('''
            CREATE TABLE sync_cursors (
              sessionId TEXT PRIMARY KEY,
              lastContiguousSeq INTEGER NOT NULL DEFAULT 0,
              lastSnapshotId TEXT,
              updatedAt INTEGER NOT NULL
            )
          ''');
          await db.execute('''
            CREATE TABLE cached_events (
              eventId TEXT PRIMARY KEY,
              sessionId TEXT NOT NULL,
              seq INTEGER NOT NULL,
              payloadJson TEXT NOT NULL,
              cachedAt INTEGER NOT NULL,
              UNIQUE (sessionId, seq)
            )
          ''');
          await db.execute(
            'CREATE INDEX cached_events_session ON cached_events (sessionId, seq)',
          );
          await db.execute('''
            CREATE TABLE cached_sessions (
              sessionId TEXT PRIMARY KEY,
              workspaceId TEXT NOT NULL,
              title TEXT NOT NULL,
              status TEXT NOT NULL,
              lastActivityAt INTEGER NOT NULL,
              cachedAt INTEGER NOT NULL
            )
          ''');
          await db.execute('''
            CREATE TABLE drafts (
              sessionId TEXT PRIMARY KEY,
              text TEXT NOT NULL,
              updatedAt INTEGER NOT NULL
            )
          ''');
          await _createVoiceDrafts(db);
        },
        onUpgrade: (db, oldVersion, newVersion) async {
          if (oldVersion < 2) await _createVoiceDrafts(db);
        },
      ),
    );
  }
}

/// v2 增量：只新增 voice_drafts 与索引，不重建既有表。
Future<void> _createVoiceDrafts(DatabaseExecutor db) async {
  await db.execute('''
    CREATE TABLE IF NOT EXISTS voice_drafts (
      voiceDraftId TEXT PRIMARY KEY,
      asrStreamId TEXT NOT NULL,
      originSessionId TEXT NOT NULL,
      originalDraft TEXT NOT NULL,
      combinedDraft TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status = 'pending'),
      createdAt INTEGER NOT NULL
    )
  ''');
  await db.execute('''
    CREATE INDEX IF NOT EXISTS voice_drafts_session
    ON voice_drafts (originSessionId, status)
  ''');
}