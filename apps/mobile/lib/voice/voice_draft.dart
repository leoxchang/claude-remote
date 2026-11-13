/// 一次语音识别结果的持久草稿。
final class VoiceDraft {
  const VoiceDraft({
    required this.voiceDraftId,
    required this.asrStreamId,
    required this.originSessionId,
    required this.originalDraft,
    required this.combinedDraft,
    required this.status,
    required this.createdAt,
  });

  factory VoiceDraft.fromRow(Map<String, Object?> row) {
    final createdAt = row['createdAt'];
    return VoiceDraft(
      voiceDraftId: row['voiceDraftId'] as String,
      asrStreamId: row['asrStreamId'] as String,
      originSessionId: row['originSessionId'] as String,
      originalDraft: row['originalDraft'] as String,
      combinedDraft: row['combinedDraft'] as String,
      status: row['status'] as String,
      createdAt: DateTime.fromMillisecondsSinceEpoch(
        createdAt is int ? createdAt : 0,
      ),
    );
  }

  final String voiceDraftId;
  final String asrStreamId;
  final String originSessionId;
  final String originalDraft;
  final String combinedDraft;

  /// 当前只允许 `pending`。
  final String status;
  final DateTime createdAt;
}