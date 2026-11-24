import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/io.dart';

import '../protocol/envelope.dart';
import 'agent_socket.dart';
import 'device_credential.dart';

/// 主控制连接地址；直连按 baseUrl 推导，云端追加 desktopId（契约 §4.1）。
Uri agentSocketUri(DeviceCredential credential) =>
    credential.webSocketUri('/ws');

/// 与服务端 `authenticateRequest` 一致的 Bearer 头：`<deviceId>.<token>`。
Map<String, String> agentSocketHeaders(DeviceCredential credential) {
  return {
    'Authorization': 'Bearer ${credential.deviceId}.${credential.deviceToken}',
  };
}

/// 真实 WSS/WS 连接；使用系统默认 TLS 校验，不支持关闭校验。
final class IoAgentSocket implements AgentSocket {
  IoAgentSocket._(this._channel);

  /// 用凭证里的 baseUrl 建立主控制连接。
  factory IoAgentSocket.connect(DeviceCredential credential) {
    final channel = IOWebSocketChannel.connect(
      agentSocketUri(credential),
      headers: agentSocketHeaders(credential),
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