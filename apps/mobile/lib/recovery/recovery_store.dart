import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

import 'cache_repository.dart';
import 'outbox_repository.dart';
import 'recovery_database.dart';
import 'user_message.dart';
import '../voice/composer_draft_store.dart';
import '../voice/voice_draft_repository.dart';

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

/// App 本地持久化门面：outbox、游标、缓存、草稿与本地提问记录。
///
/// 不保存 deviceToken、审批正文或 run prompt 响应。
final class RecoveryStore implements ComposerDraftStore, UserMessageStore, UserAttachmentStore {
  /// 每个会话最多保留的本地提问条数。
  static const int maxUserMessagesPerSession = 200;

  RecoveryStore._(
    this.db,
    this.outbox,
    this.cache,
    this.voiceDrafts,
    this._supportPath,
  );

  static Future<RecoveryStore> open({
    DatabaseFactory? factory,
    Future<Directory> Function()? supportDirectory,
    String fileName = defaultRecoveryFileName,
  }) async {
    final directory = await (supportDirectory ?? getApplicationSupportDirectory)();
    final db = await RecoveryDatabase.open(
      factory: factory,
      supportDirectory: () async => directory,
      fileName: fileName,
    );
    return RecoveryStore._(
      db,
      OutboxRepository(db),
      CacheRepository(db),
      VoiceDraftRepository(db),
      directory.path,
    );
  }

  final Database db;
  final OutboxRepository outbox;
  final CacheRepository cache;
  final VoiceDraftRepository voiceDrafts;
  final String _supportPath;

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

  /// 幂等写入本地提问；同一 commandId 的重试不会产生重复行。
  @override
  Future<void> appendUserMessage(UserMessage message) async {
    await db.insert('user_messages', {
      'sessionId': message.sessionId,
      'commandId': message.commandId,
      'text': message.text,
      'attachmentPaths': message.attachmentPaths.isEmpty
          ? null
          : jsonEncode(message.attachmentPaths),
      'createdAt': message.createdAt,
    }, conflictAlgorithm: ConflictAlgorithm.ignore);
    await db.rawDelete(
      '''
      DELETE FROM user_messages
      WHERE sessionId = ?
        AND commandId NOT IN (
          SELECT commandId FROM user_messages
          WHERE sessionId = ?
          ORDER BY createdAt DESC, commandId DESC
          LIMIT ?
        )
      ''',
      [message.sessionId, message.sessionId, maxUserMessagesPerSession],
    );
  }

  /// 按发送时间升序读取；单会话最多 200 条。
  @override
  Future<List<UserMessage>> readUserMessages(String sessionId) async {
    final rows = await db.query(
      'user_messages',
      where: 'sessionId = ?',
      whereArgs: [sessionId],
      orderBy: 'createdAt ASC, commandId ASC',
    );
    return rows.map((row) {
      final text = row['text'];
      final createdAt = row['createdAt'];
      if (text is! String || createdAt is! int) {
        throw StateError('invalid user_messages row');
      }
      return UserMessage(
        sessionId: sessionId,
        commandId: row['commandId'] as String,
        text: text,
        attachmentPaths: _decodeAttachmentPaths(row['attachmentPaths']),
        createdAt: createdAt,
      );
    }).toList(growable: false);
  }

  /// 解除配对/revoke/replace 时清空全部本地持久状态。
  Future<void> clearAll() async {
    await outbox.clearAll();
    await cache.clearAll();
    await db.delete('sync_cursors');
    await db.delete('drafts');
    await db.delete('voice_drafts');
    await db.delete('user_messages');
    final directory = Directory(p.join(_supportPath, 'user-attachments'));
    if (directory.existsSync()) {
      await directory.delete(recursive: true);
    }
  }

  /// 复制图片到支持目录；同一 commandId 的重复写入覆盖旧文件。
  @override
  Future<String> copyUserAttachment({
    required String commandId,
    required String sourcePath,
    required int index,
  }) async {
    final directory = Directory(p.join(_supportPath, 'user-attachments'));
    await directory.create(recursive: true);
    final extension = p.extension(sourcePath).isEmpty
        ? '.jpg'
        : p.extension(sourcePath);
    final target = p.join(
      directory.path,
      '${commandId.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_')}_$index$extension',
    );
    await File(sourcePath).copy(target);
    return target;
  }

  List<String> _decodeAttachmentPaths(Object? raw) {
    if (raw is! String || raw.isEmpty) return const <String>[];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const <String>[];
      return decoded.whereType<String>().toList(growable: false);
    } on FormatException {
      return const <String>[];
    }
  }

  Future<void> close() => db.close();
}