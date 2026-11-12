import 'dart:convert';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/features/chat/session_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_socket.dart';

void main() {
  late FakeAgentSocket socket;
  late CommandClient client;
  String? sessionId;

  setUp(() {
    socket = FakeAgentSocket();
    client = CommandClient(socket);
    sessionId = null;
  });

  tearDown(() async {
    await client.dispose();
    await socket.close();
  });

  SessionController buildSession() => SessionController(
    client: client,
    readSessionId: () => sessionId,
    writeSessionId: (value) => sessionId = value,
  );

  test('starts a session when none is attached', () async {
    final session = buildSession();
    final future = session.startOrAttach();
    await pumpEventQueue();

    expect(socket.sent.single, contains('session.start'));
    expect(socket.sent.single, contains('clientCapabilities'));

    socket.emitMessage(
      commandResult(
        commandId: extractCommandId(socket.sent.single),
        data: {'sessionId': 'session_01'},
      ),
    );
    final record = await future;

    expect(record.sessionId, 'session_01');
    expect(sessionId, 'session_01');
  });

  test('requests a snapshot when a session is already attached', () async {
    sessionId = 'session_01';
    final session = buildSession();
    final future = session.startOrAttach();
    await pumpEventQueue();

    expect(socket.sent.single, contains('session.snapshot'));
    socket.emitMessage(
      commandResult(commandId: extractCommandId(socket.sent.single)),
    );
    await future;

    expect(sessionId, 'session_01');
  });
}

String extractCommandId(String raw) {
  final decoded = jsonDecode(raw) as Map<String, dynamic>;
  return decoded['commandId'] as String;
}