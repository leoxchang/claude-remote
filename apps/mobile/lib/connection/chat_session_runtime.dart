import 'dart:async';

import '../domain/session.dart';
import '../features/chat/chat_controller.dart';
import '../features/chat/session_controller.dart';
import '../protocol/envelope.dart';
import '../protocol/messages.dart';
import 'connection_controller.dart';

/// 把连接、会话与聊天状态接在一起的运行时。
///
/// 握手成功后创建/附着实体会话，然后把时间线事件、快照与错误
/// 转发给 [ChatController]。
final class ChatSessionRuntime {
  ChatSessionRuntime({
    required this.connection,
    required this.session,
    required this.chat,
  });

  final ConnectionController connection;
  final SessionController session;
  final ChatController chat;

  StreamSubscription<ProtocolMessage>? _subscription;

  Future<void> start() async {
    _subscription = connection.incoming.listen(_handleMessage);
    await connection.connect();
  }

  Future<void> dispose() async {
    await _subscription?.cancel();
    await connection.dispose();
  }

  void _handleMessage(ProtocolMessage message) {
    if (message is TimelineEvent) {
      // 只把当前会话的事件送入聊天页；其他会话由 App 状态单独保存。
      final sessionId = chat.sessionId;
      if (sessionId != null && message.sessionId != sessionId) return;
      chat.mergeEvent(message);
      return;
    }
    if (message is ControlMessage && message.type == 'session.snapshot') {
      final snapshot = SessionSnapshot.fromPayload(message.payload);
      final sessionId = chat.sessionId;
      if (sessionId != null &&
          snapshot.sessionId != null &&
          snapshot.sessionId != sessionId) {
        return;
      }
      chat.mergeSnapshot(snapshot);
      return;
    }
    if (message is ControlMessage && message.type == 'error') {
      final code = message.payload['code'];
      chat.reportError(code is String ? code : 'UNKNOWN_ERROR');
    }
  }
}