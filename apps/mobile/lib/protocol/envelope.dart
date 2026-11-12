/// 协议消息公共信封；字段与 `protocol/v1/src/types.ts` 的 `MessageEnvelope` 一致。
abstract class ProtocolMessage {
  const ProtocolMessage({
    required this.messageId,
    required this.timestamp,
    required this.type,
    required this.payload,
  });

  final String messageId;
  final int timestamp;
  final String type;
  final Map<String, Object?> payload;

  /// 发送到 Mac 时使用的 wire 形式。
  Map<String, Object?> toWire();
}

/// 解码失败；只保留安全 code 与 JSON path，不回显原始输入。
class ProtocolDecodeException implements Exception {
  const ProtocolDecodeException(this.code, this.path);

  final String code;
  final String path;

  @override
  String toString() => 'ProtocolDecodeException($code at $path)';
}

/// 时间线冲突：重复 eventId 内容不同、混入其他会话或 seq 不递增。
class ProtocolConflictException implements Exception {
  const ProtocolConflictException(this.reason);

  final String reason;

  @override
  String toString() => 'ProtocolConflictException($reason)';
}