import 'dart:convert';

import 'envelope.dart';
import 'messages.dart';

const Set<String> _commandTypes = {
  'session.start',
  'prompt.send',
  'run.cancel',
  'session.snapshot',
  'workspace.list',
  'session.create',
  'session.list',
  'session.resume',
  'session.rename',
  'session.archive',
  'queue.remove',
  'permission.respond',
};

const Set<String> _eventTypes = {
  'session.status',
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.output',
  'tool.completed',
  'run.queued',
  'run.started',
  'run.completed',
  'permission.requested',
  'permission.resolved',
};

const Set<String> _controlTypes = {
  'connection.hello',
  'connection.ready',
  'desktop.status',
  'error',
};

/// 把协议 JSON 解码为强类型消息；错误只带安全 code 与 path，不回显输入。
abstract final class ProtocolDecoder {
  static ProtocolMessage decode(String json) {
    final root = _decodeObject(json);
    final version = _intField(root, 'protocolVersion', '');
    if (version != 1) {
      throw const ProtocolDecodeException(
        'UNSUPPORTED_PROTOCOL_VERSION',
        'protocolVersion',
      );
    }
    final messageId = _stringField(root, 'messageId', '');
    final timestamp = _intField(root, 'timestamp', '');
    final type = _stringField(root, 'type', '');
    final payload = _objectField(root, 'payload', '');

    if (type == 'command.result') {
      return _decodeResult(root, messageId, timestamp, type, payload);
    }
    if (_commandTypes.contains(type)) {
      if (type == 'session.snapshot' && !root.containsKey('commandId')) {
        return ControlMessage(
          messageId: messageId,
          timestamp: timestamp,
          type: type,
          payload: payload,
        );
      }
      return _decodeCommand(root, messageId, timestamp, type, payload);
    }
    if (_eventTypes.contains(type)) {
      return _decodeEventFields(root, messageId, timestamp, type, payload);
    }
    if (_controlTypes.contains(type)) {
      return ControlMessage(
        messageId: messageId,
        timestamp: timestamp,
        type: type,
        payload: payload,
      );
    }
    // 无法识别的审批事件必须 fail closed，不能静默忽略后继续需要审批的 run。
    if (type.startsWith('permission.')) {
      throw ProtocolConflictException('unsupported permission event: $type');
    }
    throw const ProtocolDecodeException('UNKNOWN_MESSAGE_TYPE', 'type');
  }

  /// 解码快照内的 `recentEvents` 条目。
  static TimelineEvent decodeEvent(Object? wire) {
    final message = decode(jsonEncode(wire));
    if (message is! TimelineEvent) {
      throw const ProtocolDecodeException('INVALID_MESSAGE', 'recentEvents');
    }
    return message;
  }

  static CommandMessage _decodeCommand(
    Map<String, Object?> root,
    String messageId,
    int timestamp,
    String type,
    Map<String, Object?> payload,
  ) {
    final commandId = _stringField(root, 'commandId', '');
    final traceId = _stringField(root, 'traceId', '');
    final sessionId = _optionalString(root, 'sessionId');
    if (type == 'prompt.send' && sessionId == null) {
      throw const ProtocolDecodeException('INVALID_MESSAGE', 'sessionId');
    }
    final runId = _optionalString(root, 'runId');
    if ((type == 'run.cancel' || type == 'queue.remove') && runId == null) {
      throw const ProtocolDecodeException('INVALID_MESSAGE', 'runId');
    }
    final approvalId = _optionalString(root, 'approvalId');
    if (type == 'permission.respond' &&
        (approvalId == null || sessionId == null || runId == null)) {
      throw const ProtocolDecodeException('INVALID_MESSAGE', 'approvalId');
    }
    return CommandMessage(
      messageId: messageId,
      timestamp: timestamp,
      type: type,
      payload: payload,
      commandId: commandId,
      traceId: traceId,
      sessionId: sessionId,
      runId: runId,
      workspaceId: _optionalString(root, 'workspaceId'),
      approvalId: approvalId,
    );
  }

  static TimelineEvent _decodeEventFields(
    Map<String, Object?> root,
    String messageId,
    int timestamp,
    String type,
    Map<String, Object?> payload,
  ) {
    final eventId = _stringField(root, 'eventId', '');
    final sessionId = _stringField(root, 'sessionId', '');
    final seq = _intField(root, 'seq', '');
    if (seq < 1) {
      throw const ProtocolDecodeException('INVALID_MESSAGE', 'seq');
    }
    return TimelineEvent(
      messageId: messageId,
      timestamp: timestamp,
      type: type,
      payload: payload,
      eventId: eventId,
      sessionId: sessionId,
      seq: seq,
      runId: _optionalString(root, 'runId'),
      approvalId: _optionalString(root, 'approvalId'),
    );
  }

  static CommandResultMessage _decodeResult(
    Map<String, Object?> root,
    String messageId,
    int timestamp,
    String type,
    Map<String, Object?> payload,
  ) {
    final commandId = _stringField(root, 'commandId', '');
    final traceId = _stringField(root, 'traceId', '');
    final status = _stringField(payload, 'status', 'payload');
    if (status != 'ok' && status != 'error') {
      throw const ProtocolDecodeException('INVALID_MESSAGE', 'payload.status');
    }
    final duplicate = payload['duplicate'];
    if (duplicate is! bool) {
      throw const ProtocolDecodeException(
        'INVALID_MESSAGE',
        'payload.duplicate',
      );
    }
    final data = payload['data'];
    if (status == 'ok' && payload.containsKey('error')) {
      throw const ProtocolDecodeException('INVALID_MESSAGE', 'payload.error');
    }
    if (status == 'error' && payload['error'] is! Map) {
      throw const ProtocolDecodeException('INVALID_MESSAGE', 'payload.error');
    }
    final error = payload['error'];
    return CommandResultMessage(
      messageId: messageId,
      timestamp: timestamp,
      type: type,
      payload: payload,
      commandId: commandId,
      traceId: traceId,
      status: status,
      duplicate: duplicate,
      data: data is Map ? data.cast<String, Object?>() : null,
      errorCode: error is Map ? _optionalString(error, 'code') : null,
      errorMessage: error is Map ? _optionalString(error, 'message') : null,
      retryable: error is Map && error['retryable'] is bool
          ? error['retryable'] as bool
          : null,
    );
  }

  static Map<String, Object?> _decodeObject(String json) {
    final Object? raw;
    try {
      raw = jsonDecode(json);
    } on FormatException {
      throw const ProtocolDecodeException('INVALID_MESSAGE', 'root');
    }
    if (raw is! Map<String, Object?>) {
      throw const ProtocolDecodeException('INVALID_MESSAGE', 'root');
    }
    return raw;
  }

  static String _stringField(
    Map<String, Object?> map,
    String key,
    String parent,
  ) {
    final value = map[key];
    if (value is! String || value.isEmpty) {
      throw ProtocolDecodeException('INVALID_MESSAGE', _path(parent, key));
    }
    return value;
  }

  static String? _optionalString(Map<dynamic, dynamic> map, String key) {
    final value = map[key];
    return value is String && value.isNotEmpty ? value : null;
  }

  static int _intField(Map<String, Object?> map, String key, String parent) {
    final value = map[key];
    if (value is! int) {
      throw ProtocolDecodeException('INVALID_MESSAGE', _path(parent, key));
    }
    return value;
  }

  static Map<String, Object?> _objectField(
    Map<String, Object?> map,
    String key,
    String parent,
  ) {
    final value = map[key];
    if (value is! Map) {
      throw ProtocolDecodeException('INVALID_MESSAGE', _path(parent, key));
    }
    return value.cast<String, Object?>();
  }

  static String _path(String parent, String key) =>
      parent.isEmpty ? key : '$parent.$key';
}