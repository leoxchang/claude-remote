import 'dart:io';

import 'package:sqflite/sqflite.dart';

import 'cache_repository.dart';
import 'outbox_repository.dart';
import 'recovery_database.dart';

final class SyncCursor {
  const SyncCursor({
    required this.sessionId,
    required this.lastContiguousSeq,
    required this.lastSnapshotId,
  });

  final String sessionId;
  final int lastContiguousSeq;
  final String? lastSnapshotId;
}

/// App 本地持久化门面：outbox、游标、缓存与草稿。
///
/// 不保存 deviceToken、审批正文或 run prompt 响应。
final class RecoveryStore {
  RecoveryStore._(
    this.db,
    this.outbox,
    this.cache,
  );

  static Future<RecoveryStore> open({
    DatabaseFactory? factory,
    Future<Directory> Function()? supportDirectory,
  }) async {
    final db = await RecoveryDatabase.open(
      factory: factory,
      supportDirectory: supportDirectory,
    );
    return RecoveryStore._(db, OutboxRepository(db), CacheRepository(db));
  }

  final Database db;
  final OutboxRepository outbox;
  final CacheRepository cache;

  Future<SyncCursor?> readCursor(String sessionId) async {
    final rows = await db.query(
      'sync_cursors',
      where: 'sessionId = ?',
      whereArgs: [sessionId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final row = rows.first;
    return SyncCursor(
      sessionId: row['sessionId'] as String,
      lastContiguousSeq: row['lastContiguousSeq'] as int,
      lastSnapshotId: row['lastSnapshotId'] as String?,
    );
  }

  Future<void> writeCursor({
    required String sessionId,
    required int lastContiguousSeq,
    String? lastSnapshotId,
  }) {
    return db.insert('sync_cursors', {
      'sessionId': sessionId,
      'lastContiguousSeq': lastContiguousSeq,
      'lastSnapshotId': lastSnapshotId,
      'updatedAt': DateTime.now().millisecondsSinceEpoch,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<String?> readDraft(String sessionId) async {
    final rows = await db.query(
      'drafts',
      where: 'sessionId = ?',
      whereArgs: [sessionId],
      limit: 1,
    );
    return rows.isEmpty ? null : rows.first['text'] as String;
  }

  Future<void> saveDraft(String sessionId, String text) {
    return db.insert('drafts', {
      'sessionId': sessionId,
      'text': text,
      'updatedAt': DateTime.now().millisecondsSinceEpoch,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> clearDraft(String sessionId) {
    return db.delete(
      'drafts',
      where: 'sessionId = ?',
      whereArgs: [sessionId],
    );
  }

  /// 解除配对/revoke/replace 时清空全部本地持久状态。
  Future<void> clearAll() async {
    await outbox.clearAll();
    await cache.clearAll();
    await db.delete('sync_cursors');
    await db.delete('drafts');
  }

  Future<void> close() => db.close();
}