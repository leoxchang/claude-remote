import 'dart:async';
import 'dart:convert';

import '../protocol/envelope.dart';
import '../protocol/messages.dart';
import 'agent_socket.dart';
import 'device_credential.dart';
import 'io_agent_socket.dart';
import 'pairing_api.dart';

/// 完成 `connection.hello` / `connection.ready` 握手的命令连接。
///
/// 项目与会话列表走独立连接，服务端要求首条消息必须是 hello，
/// 否则 10 秒后关闭；此包装负责握手并继续转发消息。
final class ReadyAgentSocket implements AgentSocket {
  ReadyAgentSocket._(this._inner, this._messages, this._subscription);

  final AgentSocket _inner;
  final StreamController<String> _messages;
  final StreamSubscription<String> _subscription;

  /// 建立真实连接并等待握手完成。
  static Future<ReadyAgentSocket> connect(
    DeviceCredential credential, {
    Duration timeout = const Duration(seconds: 10),
  }) {
    return openReadySocket(
      IoAgentSocket.connect(credential),
      credential,
      timeout: timeout,
    );
  }

  @override
  Stream<String> get messages => _messages.stream;

  @override
  Future<void> send(ProtocolMessage message) => _inner.send(message);

  @override
  Future<void> close() async {
    await _subscription.cancel();
    if (!_messages.isClosed) await _messages.close();
    await _inner.close();
  }
}

/// 在给定 socket 上完成握手；测试可注入假连接。
Future<ReadyAgentSocket> openReadySocket(
  AgentSocket inner,
  DeviceCredential credential, {
  Duration timeout = const Duration(seconds: 10),
  String appVersion = PairingApi.appVersion,
}) async {
  final messages = StreamController<String>.broadcast();
  final ready = Completer<void>();
  final subscription = inner.messages.listen(
    (raw) {
      messages.add(raw);
      if (!ready.isCompleted && _isReady(raw)) ready.complete();
    },
    onError: (Object error, StackTrace stack) {
      if (!ready.isCompleted) ready.completeError(error, stack);
      messages.addError(error, stack);
    },
    onDone: () {
      if (!ready.isCompleted) {
        ready.completeError(StateError('socket closed before ready'));
      }
      unawaited(messages.close());
    },
  );
  final handshakeId = 'hs_cmd_${DateTime.now().microsecondsSinceEpoch}';
  await inner.send(
    ControlMessage(
      messageId: 'msg_$handshakeId',
      timestamp: DateTime.now().millisecondsSinceEpoch,
      type: 'connection.hello',
      payload: {
        'supportedProtocolVersions': [1],
        'appVersion': appVersion,
        'deviceId': credential.deviceId,
        'capabilities': ['text'],
        'handshakeId': handshakeId,
      },
    ),
  );
  try {
    await ready.future.timeout(timeout);
  } on Object {
    await subscription.cancel();
    if (!messages.isClosed) await messages.close();
    await inner.close();
    rethrow;
  }
  return ReadyAgentSocket._(inner, messages, subscription);
}

bool _isReady(String raw) {
  final Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } on FormatException {
    return false;
  }
  return decoded is Map<String, Object?> &&
      decoded['type'] == 'connection.ready';
}