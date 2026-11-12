import 'dart:async';
import 'dart:convert';

import 'package:claude_remote/data/agent_socket.dart';
import 'package:claude_remote/protocol/envelope.dart';

/// 可手动驱动的假连接；测试不打开真实 WebSocket。
final class FakeAgentSocket implements AgentSocket {
  final StreamController<String> _controller =
      StreamController<String>.broadcast();
  final List<String> sent = <String>[];
  bool closed = false;

  @override
  Stream<String> get messages => _controller.stream;

  @override
  Future<void> send(ProtocolMessage message) async {
    sent.add(jsonEncode(message.toWire()));
  }

  @override
  Future<void> close() async {
    closed = true;
    if (!_controller.isClosed) await _controller.close();
  }

  void emitMessage(Map<String, Object?> message) {
    if (!_controller.isClosed) _controller.add(jsonEncode(message));
  }
}

/// 按顺序产出假连接，便于断言重连次数。
final class FakeSocketFactory {
  final List<FakeAgentSocket> sockets = <FakeAgentSocket>[];

  AgentSocket call() {
    final socket = FakeAgentSocket();
    sockets.add(socket);
    return socket;
  }
}

Map<String, Object?> commandResult({
  required String commandId,
  String status = 'ok',
  Map<String, Object?>? data,
  Map<String, Object?>? error,
}) {
  return {
    'protocolVersion': 1,
    'messageId': 'msg_result_$commandId',
    'timestamp': 1762432800000,
    'type': 'command.result',
    'commandId': commandId,
    'traceId': 'trace_01',
    'payload': {
      'status': status,
      'duplicate': false,
      'data': ?data,
      'error': ?error,
    },
  };
}

Map<String, Object?> readyMessage({
  String handshakeId = 'hs_1',
  int connectionEpoch = 1,
}) {
  return {
    'protocolVersion': 1,
    'messageId': 'msg_ready',
    'timestamp': 1762432800000,
    'type': 'connection.ready',
    'payload': {
      'desktopId': 'desktop_01',
      'connectionEpoch': connectionEpoch,
      'versions': {'agent': '0.0.1', 'sdk': '0.3.319', 'runtime': '2.1.319'},
      'capabilities': ['text'],
      'handshakeId': handshakeId,
    },
  };
}