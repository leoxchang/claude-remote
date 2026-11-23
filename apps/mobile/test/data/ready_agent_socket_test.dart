import 'dart:async';
import 'dart:convert';

import 'package:claude_remote/data/agent_socket.dart';
import 'package:claude_remote/data/device_credential.dart';
import 'package:claude_remote/data/ready_agent_socket.dart';
import 'package:claude_remote/protocol/envelope.dart';
import 'package:flutter_test/flutter_test.dart';

final class FakeSocket implements AgentSocket {
  FakeSocket({this.replyReady = true});

  final StreamController<String> _messages =
      StreamController<String>.broadcast();
  final List<ProtocolMessage> sent = <ProtocolMessage>[];
  final bool replyReady;
  bool closed = false;

  @override
  Stream<String> get messages => _messages.stream;

  @override
  Future<void> send(ProtocolMessage message) async {
    sent.add(message);
    if (replyReady && message.type == 'connection.hello') {
      _messages.add(
        jsonEncode(<String, Object?>{
          'protocolVersion': 1,
          'messageId': 'msg_ready',
          'timestamp': DateTime.now().millisecondsSinceEpoch,
          'type': 'connection.ready',
          'payload': <String, Object?>{'agentInstanceId': 'agent_test'},
        }),
      );
    }
  }

  void emit(Map<String, Object?> message) => _messages.add(jsonEncode(message));

  @override
  Future<void> close() async {
    closed = true;
    await _messages.close();
  }
}

const DeviceCredential credential = DeviceCredential(
  deviceId: 'device_1',
  deviceToken: 'secret_token',
  baseUrl: 'http://192.168.5.10:8787',
);

void main() {
  test('sends hello and resolves only after connection.ready', () async {
    final fake = FakeSocket();

    final socket = await openReadySocket(
      fake,
      credential,
      timeout: const Duration(seconds: 1),
    );

    expect(fake.sent.single.type, 'connection.hello');
    expect(fake.sent.single.payload['deviceId'], 'device_1');
    expect(fake.sent.single.payload['supportedProtocolVersions'], [1]);

    final received = <String>[];
    final subscription = socket.messages.listen(received.add);
    fake.emit(<String, Object?>{'type': 'session.snapshot', 'payload': {}});
    await Future<void>.delayed(Duration.zero);

    expect(received, hasLength(1));
    await subscription.cancel();
    await socket.close();
    expect(fake.closed, isTrue);
  });

  test('times out and closes when ready never arrives', () async {
    final fake = FakeSocket(replyReady: false);

    await expectLater(
      openReadySocket(
        fake,
        credential,
        timeout: const Duration(milliseconds: 10),
      ),
      throwsA(isA<TimeoutException>()),
    );
    expect(fake.closed, isTrue);
  });
}