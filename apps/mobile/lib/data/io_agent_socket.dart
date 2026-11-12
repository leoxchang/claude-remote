import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/io.dart';

import '../protocol/envelope.dart';
import 'agent_socket.dart';
import 'device_credential.dart';

/// 真实 WSS 连接；使用系统默认 TLS 校验，不支持关闭校验。
final class IoAgentSocket implements AgentSocket {
  IoAgentSocket._(this._channel);

  /// 用凭证里的 baseUrl 建立 `wss://<host>/ws`，令牌只放在 Authorization 头。
  factory IoAgentSocket.connect(DeviceCredential credential) {
    final base = Uri.parse(credential.baseUrl);
    final uri = base.replace(scheme: 'wss', path: '/ws');
    final channel = IOWebSocketChannel.connect(
      uri,
      headers: {'Authorization': 'Bearer ${credential.deviceToken}'},
      pingInterval: const Duration(seconds: 15),
      connectTimeout: const Duration(seconds: 10),
    );
    return IoAgentSocket._(channel);
  }

  final IOWebSocketChannel _channel;

  /// 抓包流被 CommandClient 与 ConnectionController 同时订阅。
  late final Stream<String> _messages = _channel.stream
      .cast<String>()
      .asBroadcastStream();

  @override
  Stream<String> get messages => _messages;

  @override
  Future<void> send(ProtocolMessage message) async {
    _channel.sink.add(jsonEncode(message.toWire()));
  }

  @override
  Future<void> close() async {
    await _channel.sink.close();
  }
}