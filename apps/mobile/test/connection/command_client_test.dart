import 'dart:convert';

import 'package:claude_remote/connection/command_client.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_socket.dart';

CommandRequest<Map<String, dynamic>> startRequest({
  String commandId = 'cmd_01',
}) {
  return CommandRequest<Map<String, dynamic>>(
    commandId: commandId,
    traceId: 'trace_01',
    type: 'session.start',
    payload: {
      'clientCapabilities': ['text'],
      'workspaceId': 'default',
    },
    decode: (data) => data,
  );
}

Map<String, Object?> sentEnvelope(String raw) =>
    jsonDecode(raw) as Map<String, Object?>;

void main() {
  late FakeAgentSocket socket;
  late CommandClient client;

  setUp(() {
    socket = FakeAgentSocket();
    client = CommandClient(socket);
  });

  tearDown(() async {
    await client.dispose();
    await socket.close();
  });

  test('sends the command envelope and resolves with the result data', () async {
    final future = client.execute(startRequest());

    await pumpEventQueue();
    final envelope = sentEnvelope(socket.sent.single);
    expect(envelope['type'], 'session.start');
    expect(envelope['commandId'], 'cmd_01');
    expect(envelope['traceId'], 'trace_01');
    expect(envelope['protocolVersion'], 1);

    socket.emitMessage(
      commandResult(
        commandId: 'cmd_01',
        data: {'sessionId': 'session_01'},
      ),
    );
    final data = await future;

    expect(data['sessionId'], 'session_01');
  });

  test('throws CommandFailure with the server error code', () async {
    final future = client.execute(startRequest());

    await pumpEventQueue();
    socket.emitMessage(
      commandResult(
        commandId: 'cmd_01',
        status: 'error',
        error: {
          'code': 'SESSION_BUSY',
          'message': '当前会话已有任务执行',
          'retryable': true,
        },
      ),
    );

    await expectLater(
      future,
      throwsA(
        isA<CommandFailure>().having((error) => error.code, 'code', 'SESSION_BUSY'),
      ),
    );
  });

  test('ignores results for other commands and duplicate results', () async {
    final future = client.execute(startRequest());

    await pumpEventQueue();
    socket.emitMessage(commandResult(commandId: 'cmd_other'));
    socket.emitMessage(
      commandResult(commandId: 'cmd_01', data: {'sessionId': 'session_01'}),
    );
    socket.emitMessage(
      commandResult(commandId: 'cmd_01', data: {'sessionId': 'session_02'}),
    );

    final data = await future;
    expect(data['sessionId'], 'session_01');
  });

  test('times out without changing the commandId for a retry', () async {
    final request = startRequest();

    await expectLater(
      client.execute(request, timeout: const Duration(milliseconds: 10)),
      throwsA(isA<CommandTimeout>()),
    );
    expect(socket.sent, hasLength(1));

    final retry = client.execute(request);
    await pumpEventQueue();
    socket.emitMessage(
      commandResult(commandId: 'cmd_01', data: {'sessionId': 'session_01'}),
    );
    await retry;

    expect(socket.sent, hasLength(2));
    expect(sentEnvelope(socket.sent[0])['commandId'], 'cmd_01');
    expect(sentEnvelope(socket.sent[1])['commandId'], 'cmd_01');
  });

  test('ignores malformed incoming frames', () async {
    final future = client.execute(startRequest());

    await pumpEventQueue();
    socket.emitMessage({'type': 'unknown.type'});
    socket.emitMessage({'protocolVersion': 1});
    socket.emitMessage(
      commandResult(commandId: 'cmd_01', data: {'sessionId': 'session_01'}),
    );

    final data = await future;
    expect(data['sessionId'], 'session_01');
  });
}