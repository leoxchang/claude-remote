import 'dart:async';
import 'dart:convert';

import 'package:claude_remote/connection/chat_session_runtime.dart';
import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/connection_controller.dart';
import 'package:claude_remote/features/chat/chat_controller.dart';
import 'package:claude_remote/features/chat/session_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../connection/fake_socket.dart';

String typeOf(String raw) =>
    (jsonDecode(raw) as Map<String, dynamic>)['type'] as String;

String commandIdOf(String raw) =>
    (jsonDecode(raw) as Map<String, dynamic>)['commandId'] as String;

void main() {
  late FakeAgentSocket socket;
  late ProviderContainer container;
  late ChatController chat;
  late ChatSessionRuntime runtime;

  ChatState state() => container.read(chatControllerProvider);

  setUp(() {
    socket = FakeAgentSocket();
    container = ProviderContainer();
    chat = container.read(chatControllerProvider.notifier);
    final client = CommandClient();
    final session = SessionController(
      client: client,
      readSessionId: () => chat.sessionId,
      writeSessionId: chat.attachSession,
    );
    final connection = ConnectionController(
      socketFactory: () => socket,
      deviceId: 'device_01',
      appVersion: '1.0.0',
      onSocket: client.replaceSocket,
      onStatus: chat.setConnection,
      onReady: () async {
        chat.setSyncing(true);
        final record = await session.startOrAttach();
        chat.attachSession(record.sessionId);
        chat.setSyncing(false);
      },
      delay: (_) async {},
      jitter: () => Duration.zero,
    );
    runtime = ChatSessionRuntime(
      connection: connection,
      session: session,
      chat: chat,
    );
  });

  tearDown(() async {
    await runtime.dispose();
    await socket.close();
    container.dispose();
  });

  Future<void> connectAndAttach() async {
    unawaited(runtime.start());
    await pumpEventQueue();
    expect(typeOf(socket.sent.single), 'connection.hello');

    socket.emitMessage(readyMessage());
    await pumpEventQueue();

    final startFrame = socket.sent.firstWhere(
      (raw) => typeOf(raw) == 'session.start',
    );
    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(startFrame),
        data: {'sessionId': 'session_01'},
      ),
    );
    await pumpEventQueue();
  }

  test('connects, starts the session and marks the link ready', () async {
    await connectAndAttach();

    expect(state().connection, ConnectionStatus.ready);
    expect(chat.sessionId, 'session_01');
    expect(state().syncing, isFalse);
  });

  test('applies timeline events from the socket', () async {
    await connectAndAttach();
    socket.emitMessage({
      'protocolVersion': 1,
      'messageId': 'msg_event_1',
      'timestamp': 1,
      'type': 'message.delta',
      'eventId': 'event_1',
      'sessionId': 'session_01',
      'seq': 1,
      'payload': {'assistantMessageId': 'm1', 'text': '你好'},
    });
    await pumpEventQueue();

    expect(state().timeline?.messages.single.text, '你好');
  });

  test('applies a snapshot and clears the syncing flag', () async {
    await connectAndAttach();
    socket.emitMessage({
      'protocolVersion': 1,
      'messageId': 'msg_snapshot',
      'timestamp': 2,
      'type': 'session.snapshot',
      'payload': {
        'recentEvents': [],
        'lastSeq': 7,
        'snapshotTruncated': true,
      },
    });
    await pumpEventQueue();

    expect(state().timeline?.lastSeq, 7);
    expect(state().snapshotTruncated, isTrue);
  });

  test('surfaces protocol errors as a safe message', () async {
    await connectAndAttach();
    socket.emitMessage({
      'protocolVersion': 1,
      'messageId': 'msg_error',
      'timestamp': 3,
      'type': 'error',
      'payload': {'code': 'DEVICE_REVOKED'},
    });
    await pumpEventQueue();

    expect(state().error, 'DEVICE_REVOKED');
  });

  test('dispose closes the socket', () async {
    await connectAndAttach();
    await runtime.dispose();

    expect(socket.closed, isTrue);
  });
}