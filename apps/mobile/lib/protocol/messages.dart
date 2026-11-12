import 'envelope.dart';

/// 手机发出的命令；`commandId` 与 `traceId` 必填。
final class CommandMessage extends ProtocolMessage {
  const CommandMessage({
    required super.messageId,
    required super.timestamp,
    required super.type,
    required super.payload,
    required this.commandId,
    required this.traceId,
    this.sessionId,
    this.runId,
    this.workspaceId,
  });

  final String commandId;
  final String traceId;
  final String? sessionId;
  final String? runId;
  final String? workspaceId;

  @override
  Map<String, Object?> toWire() {
    return {
      'protocolVersion': 1,
      'messageId': messageId,
      'timestamp': timestamp,
      'type': type,
      'commandId': commandId,
      'traceId': traceId,
      if (sessionId != null) 'sessionId': sessionId,
      if (runId != null) 'runId': runId,
      if (workspaceId != null) 'workspaceId': workspaceId,
      'payload': payload,
    };
  }
}

/// 命令结果；不占用会话 seq。
final class CommandResultMessage extends ProtocolMessage {
  const CommandResultMessage({
    required super.messageId,
    required super.timestamp,
    required super.type,
    required super.payload,
    required this.commandId,
    required this.traceId,
    required this.status,
    required this.duplicate,
    this.data,
    this.errorCode,
    this.errorMessage,
    this.retryable,
  });

  final String commandId;
  final String traceId;
  final String status;
  final bool duplicate;
  final Map<String, Object?>? data;
  final String? errorCode;
  final String? errorMessage;
  final bool? retryable;

  @override
  Map<String, Object?> toWire() => _envelope(this);
}

/// 占用会话 seq 的时间线事件。
final class TimelineEvent extends ProtocolMessage {
  const TimelineEvent({
    required super.messageId,
    required super.timestamp,
    required super.type,
    required super.payload,
    required this.eventId,
    required this.sessionId,
    required this.seq,
    this.runId,
  });

  final String eventId;
  final String sessionId;
  final int seq;
  final String? runId;

  @override
  Map<String, Object?> toWire() => _envelope(this);
}

/// 握手、桌面状态、快照和错误等不占用 seq 的控制消息。
final class ControlMessage extends ProtocolMessage {
  const ControlMessage({
    required super.messageId,
    required super.timestamp,
    required super.type,
    required super.payload,
  });

  @override
  Map<String, Object?> toWire() => _envelope(this);
}

/// App 只发送命令；其余消息的 wire 形式仅为满足统一接口。
Map<String, Object?> _envelope(ProtocolMessage message) {
  return {
    'protocolVersion': 1,
    'messageId': message.messageId,
    'timestamp': message.timestamp,
    'type': message.type,
    'payload': message.payload,
  };
}