/// Composer 草稿的持久化边界；RecoveryStore 实现。
abstract interface class ComposerDraftStore {
  Future<String?> readDraft(String sessionId);
  Future<void> saveDraft(String sessionId, String text);
  Future<void> clearDraft(String sessionId);
}