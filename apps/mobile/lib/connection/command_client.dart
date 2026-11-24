import 'dart:async';

import '../data/agent_socket.dart';
import '../protocol/decoder.dart';
import '../protocol/envelope.dart';
import '../protocol/messages.dart';

/// 命令返回错误状态；code 来自 `command.result.error.code`。
final class CommandFailure implements Exception {
  const CommandFailure(this.code);

  final String code;

  @override
  String toString() => 'CommandFailure($code)';
}

/// 命令超时；调用方应使用同一 request（同一 commandId）原样重试。
final class CommandTimeout implements Exception {
  const CommandTimeout(this.commandId);

  final String commandId;

  @override
  String toString() => 'CommandTimeout($commandId)';
}

/// 一条可重试命令；重试必须复用同一实例，commandId 不重新生成。
final class CommandRequest<T> {
  const CommandRequest({
    required this.commandId,
    required this.traceId,
    required this.type,
    required this.decode,
    this.sessionId,
    this.runId,
    this.workspaceId,
    this.approvalId,
    this.payload = const <String, dynamic>{},
  });

  final String commandId;
  final String traceId;
  final String type;
  final String? sessionId;
  final String? runId;
  final String? workspaceId;
  final String? approvalId;
  final JsonMap payload;
  final T Function(JsonMap data) decode;

  /// 构造待发送的消息；messageId 每次发送唯一，commandId 保持不变。
  CommandMessage toMessage(int sequence) {
    return CommandMessage(
      messageId: 'msg_${commandId}_$sequence',
      timestamp: DateTime.now().millisecondsSinceEpoch,
      type: type,
      payload: payload,
      commandId: commandId,
      traceId: traceId,
      sessionId: sessionId,
      runId: runId,
      workspaceId: workspaceId,
      approvalId: approvalId,
    );
  }
}

/// 命令执行接口；测试可注入内存实现。
abstract interface class CommandExecutor {
  Future<T> execute<T>(
    CommandRequest<T> request, {
    Duration timeout = const Duration(seconds: 10),
  });
}

/// 在单条连接上发送命令并按 commandId 匹配结果。
final class CommandClient implements CommandExecutor {
  CommandClient([AgentSocket? socket]) {
    if (socket != null) _attach(socket);
  }

  AgentSocket? _socket;
  StreamSubscription<String>? _subscription;
  final Map<String, Completer<CommandResultMessage>> _pending = {};
  int _sent = 0;

  /// 重连后换到新连接；旧订阅先取消，未完成命令等待新结果。
  Future<void> replaceSocket(AgentSocket socket) async {
    await _subscription?.cancel();
    _attach(socket);
  }

  void _attach(AgentSocket socket) {
    _socket = socket;
    _subscription = socket.messages.listen(_onRaw);
  }

  @override
  Future<T> execute<T>(
    CommandRequest<T> request, {
    Duration timeout = const Duration(seconds: 10),
  }) async {
    final completer = Completer<CommandResultMessage>();
    _pending[request.commandId] = completer;
    try {
      final socket = _socket;
      if (socket == null) throw const CommandFailure('NOT_CONNECTED');
      try {
        await socket.send(request.toMessage(++_sent));
      } on StateError {
        // WebSocket sink 已关闭时写入抛 StateError；对外统一为可识别的连接错误。
        throw const CommandFailure('NOT_CONNECTED');
      }
      final result = await completer.future.timeout(
        timeout,
        onTimeout: () {
          throw CommandTimeout(request.commandId);
        },
      );
      if (result.status != 'ok') {
        throw CommandFailure(result.errorCode ?? 'COMMAND_FAILED');
      }
      return request.decode(JsonMap.from(result.data ?? const {}));
    } finally {
      _pending.remove(request.commandId);
    }
  }

  Future<void> dispose() async {
    await _subscription?.cancel();
  }

  void _onRaw(String raw) {
    final ProtocolMessage message;
    try {
      message = ProtocolDecoder.decode(raw);
    } on ProtocolDecodeException {
      return;
    }
    if (message is! CommandResultMessage) return;
    final pending = _pending[message.commandId];
    if (pending == null || pending.isCompleted) return;
    pending.complete(message);
  }
}