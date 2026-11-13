import 'package:sqflite/sqflite.dart';

import 'voice_draft.dart';

/// 草稿在 final 前被其他路径修改；不得静默覆盖。
final class VoiceDraftConflict implements Exception {
  const VoiceDraftConflict();
}

/// 草稿不存在。
final class VoiceDraftNotFound implements Exception {
  const VoiceDraftNotFound();
}

/// final 文本写入 drafts 与 voice_drafts 的同一事务入口。
abstract interface class VoiceDraftStore {
  Future<VoiceDraft> commitFinal({
    required String voiceDraftId,
    required String asrStreamId,
    required String originSessionId,
    required String originalDraft,
    required String finalText,
  });
  Future<VoiceDraft> updateCombinedDraft(
    String voiceDraftId,
    String combinedDraft,
  );
  Future<void> restoreOriginal(String voiceDraftId);

  /// 在调用方事务内删除；用于 outbox 入队与草稿消费同事务。
  Future<void> deleteWithin(Transaction txn, String voiceDraftId);

  Future<VoiceDraft?> find(String voiceDraftId);
  Future<List<VoiceDraft>> pendingForSession(String sessionId);
}

/// final 文本写入 drafts 与 voice_drafts 的同一事务入口。
final class VoiceDraftRepository implements VoiceDraftStore {
  VoiceDraftRepository(this._db, {DateTime Function()? clock})
    : _clock = clock ?? DateTime.now;

  final Database _db;
  final DateTime Function() _clock;

  /// 把 final 追加到原草稿，并写入 pending voice draft。
  @override
  Future<VoiceDraft> commitFinal({
    required String voiceDraftId,
    required String asrStreamId,
    required String originSessionId,
    required String originalDraft,
    required String finalText,
  }) {
    return _db.transaction((txn) async {
      final current = await _readDraft(txn, originSessionId);
      if ((current ?? '') != originalDraft) {
        throw const VoiceDraftConflict();
      }
      final combined =
          originalDraft.isEmpty ? finalText : '$originalDraft\n$finalText';
      final createdAt = _clock().millisecondsSinceEpoch;
      await _writeDraft(txn, originSessionId, combined, createdAt);
      await txn.insert('voice_drafts', {
        'voiceDraftId': voiceDraftId,
        'asrStreamId': asrStreamId,
        'originSessionId': originSessionId,
        'originalDraft': originalDraft,
        'combinedDraft': combined,
        'status': 'pending',
        'createdAt': createdAt,
      });
      return VoiceDraft(
        voiceDraftId: voiceDraftId,
        asrStreamId: asrStreamId,
        originSessionId: originSessionId,
        originalDraft: originalDraft,
        combinedDraft: combined,
        status: 'pending',
        createdAt: DateTime.fromMillisecondsSinceEpoch(createdAt),
      );
    });
  }

  /// 用户编辑后同步 voice_drafts.combinedDraft 与 drafts.text。
  @override
  Future<VoiceDraft> updateCombinedDraft(
    String voiceDraftId,
    String combinedDraft,
  ) {
    return _db.transaction((txn) async {
      final row = await _findWithin(txn, voiceDraftId);
      if (row == null) throw const VoiceDraftNotFound();
      await txn.update(
        'voice_drafts',
        {'combinedDraft': combinedDraft},
        where: 'voiceDraftId = ?',
        whereArgs: [voiceDraftId],
      );
      await _writeDraft(
        txn,
        row.originSessionId,
        combinedDraft,
        _clock().millisecondsSinceEpoch,
      );
      return VoiceDraft(
        voiceDraftId: row.voiceDraftId,
        asrStreamId: row.asrStreamId,
        originSessionId: row.originSessionId,
        originalDraft: row.originalDraft,
        combinedDraft: combinedDraft,
        status: row.status,
        createdAt: row.createdAt,
      );
    });
  }

  /// 恢复原草稿并删除 voice draft；同事务。
  @override
  Future<void> restoreOriginal(String voiceDraftId) {
    return _db.transaction((txn) async {
      final row = await _findWithin(txn, voiceDraftId);
      if (row == null) return;
      await _writeDraft(
        txn,
        row.originSessionId,
        row.originalDraft,
        _clock().millisecondsSinceEpoch,
      );
      await txn.delete(
        'voice_drafts',
        where: 'voiceDraftId = ?',
        whereArgs: [voiceDraftId],
      );
    });
  }

  /// 在调用方事务内删除；用于 outbox 入队与草稿消费同事务。
  @override
  Future<void> deleteWithin(Transaction txn, String voiceDraftId) {
    return txn.delete(
      'voice_drafts',
      where: 'voiceDraftId = ?',
      whereArgs: [voiceDraftId],
    );
  }

  @override
  Future<VoiceDraft?> find(String voiceDraftId) async {
    final rows = await _db.query(
      'voice_drafts',
      where: 'voiceDraftId = ?',
      whereArgs: [voiceDraftId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return VoiceDraft.fromRow(rows.first);
  }

  @override
  Future<List<VoiceDraft>> pendingForSession(String sessionId) async {
    final rows = await _db.query(
      'voice_drafts',
      where: 'originSessionId = ? AND status = ?',
      whereArgs: [sessionId, 'pending'],
      orderBy: 'createdAt ASC',
    );
    return rows.map(VoiceDraft.fromRow).toList();
  }

  Future<String?> _readDraft(Transaction txn, String sessionId) async {
    final rows = await txn.query(
      'drafts',
      columns: ['text'],
      where: 'sessionId = ?',
      whereArgs: [sessionId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return rows.first['text'] as String?;
  }

  Future<void> _writeDraft(
    Transaction txn,
    String sessionId,
    String text,
    int updatedAt,
  ) {
    return txn.insert(
      'drafts',
      {'sessionId': sessionId, 'text': text, 'updatedAt': updatedAt},
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<VoiceDraft?> _findWithin(
    Transaction txn,
    String voiceDraftId,
  ) async {
    final rows = await txn.query(
      'voice_drafts',
      where: 'voiceDraftId = ?',
      whereArgs: [voiceDraftId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return VoiceDraft.fromRow(rows.first);
  }
}