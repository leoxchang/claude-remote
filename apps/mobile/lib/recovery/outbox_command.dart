import 'dart:convert';

/// 持久化的执行意图快照；只有 commandId、目标与原始 payload。
final class PersistedCommandSnapshot {
  const PersistedCommandSnapshot({
    required this.commandId,
    required this.sessionId,
    required this.type,
    required this.payload,
    required this.agentInstanceId,
  });

  final String commandId;
  final String sessionId;
  final String type;
  final Map<String, Object?> payload;
  final String? agentInstanceId;

  String get payloadJson => jsonEncode(payload);

  static Map<String, Object?> decodePayload(String? json) {
    if (json == null || json.isEmpty) return const <String, Object?>{};
    final decoded = jsonDecode(json);
    return decoded is Map
        ? decoded.map((key, value) => MapEntry('$key', value))
        : const <String, Object?>{};
  }
}