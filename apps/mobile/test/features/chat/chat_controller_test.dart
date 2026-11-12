import 'dart:convert';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/connection_controller.dart';
import 'package:claude_remote/data/providers.dart';
import 'package:claude_remote/features/chat/chat_controller.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../connection/fake_socket.dart';

String lastCommandId(FakeAgentSocket socket) {
  final decoded = jsonDecode(socket.sent.last) as Map<String, dynamic>;
  return decoded['commandId'] as String;
}

String lastCommandType(FakeAgentSocket socket) {
  final decoded = jsonDecode(socket.sent.last) as Map<String, dynamic>;
  return decoded['type'] as String;
}

void main() {
  late FakeAgentSocket socket;
  late CommandClient client;
  late ProviderContainer container;

  ChatController controller() =>
      container.read(chatControllerProvider.notifier);

  ChatState state() => container.read(chatControllerProvider);

  setUp(() {
    socket = FakeAgentSocket();
    client = CommandClient(socket);
    container = ProviderContainer(
      overrides: [
        commandClientProvider.overrideWith((ref) async => client),
      ],
    );
    final chat = controller();
    chat.attachSession('session_01');
    chat.setConnection(ConnectionStatus.ready);
  });

  tearDown(() async {
    await client.dispose();
    await socket.close();
    container.dispose();
  });

  test('rejects a blank draft without sending', () async {
    await controller().sendText();

    expect(socket.sent, isEmpty);
    expect(state().error, contains('请输入内容'));
  });

  test('rejects a draft above 16 KiB before sending', () async {
    controller().updateDraft('a' * (maxPromptBytes + 1));

    await controller().sendText();

    expect(socket.sent, isEmpty);
    expect(state().error, contains('16 KiB'));
  });

  test('blocks sending while offline', () async {
    controller().setConnection(ConnectionStatus.disconnected);
    controller().updateDraft('hello');

    await controller().sendText();

    expect(socket.sent, isEmpty);
    expect(state().error, contains('Mac 未连接'));
  });

  test('blocks sending while the timeline is syncing', () async {
    controller().setSyncing(true);
    controller().updateDraft('hello');

    await controller().sendText();

    expect(socket.sent, isEmpty);
    expect(state().error, contains('同步'));
  });

  test('sends prompt.send and clears the draft on success', () async {
    controller().updateDraft('hello');
    final future = controller().sendText();
    await pumpEventQueue();

    expect(lastCommandType(socket), 'prompt.send');
    socket.emitMessage(
      commandResult(commandId: lastCommandId(socket), data: {'runId': 'run_01'}),
    );
    await future;

    expect(state().draft, isEmpty);
    expect(state().activeRunId, 'run_01');
    expect(state().busy, isTrue);
  });

  test('keeps the draft and reports SESSION_BUSY', () async {
    controller().updateDraft('hello');
    final future = controller().sendText();
    await pumpEventQueue();

    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        status: 'error',
        error: {
          'code': 'SESSION_BUSY',
          'message': 'busy',
          'retryable': true,
        },
      ),
    );
    await future;

    expect(state().draft, 'hello');
    expect(state().error, contains('已有任务'));
    expect(state().busy, isFalse);
  });

  test('keeps the same commandId when retrying after a timeout', () async {
    final timeoutSocket = FakeAgentSocket();
    final timeoutClient = CommandClient(timeoutSocket);
    final timeoutContainer = ProviderContainer(
      overrides: [
        commandClientProvider.overrideWith((ref) async => timeoutClient),
        promptTimeoutProvider.overrideWithValue(
          const Duration(milliseconds: 10),
        ),
      ],
    );
    addTearDown(() async {
      await timeoutClient.dispose();
      await timeoutSocket.close();
      timeoutContainer.dispose();
    });
    final chat = timeoutContainer.read(chatControllerProvider.notifier);
    chat.attachSession('session_01');
    chat.setConnection(ConnectionStatus.ready);
    chat.updateDraft('hello');

    await chat.sendText();
    final firstId = lastCommandId(timeoutSocket);
    expect(
      timeoutContainer.read(chatControllerProvider).composer,
      ComposerStatus.unknown,
    );

    final retry = chat.retryUnknownCommand();
    await pumpEventQueue();
    expect(lastCommandId(timeoutSocket), firstId);
    timeoutSocket.emitMessage(
      commandResult(commandId: firstId, data: {'runId': 'run_01'}),
    );
    await retry;

    expect(timeoutContainer.read(chatControllerProvider).busy, isTrue);
  });

  test('clears busy state when run.completed arrives', () async {
    controller().updateDraft('hello');
    final future = controller().sendText();
    await pumpEventQueue();
    socket.emitMessage(
      commandResult(commandId: lastCommandId(socket), data: {'runId': 'run_01'}),
    );
    await future;
    expect(state().busy, isTrue);

    controller().mergeEvent(
      TimelineEvent(
        messageId: 'msg_1',
        timestamp: 1,
        type: 'run.completed',
        payload: {'status': 'succeeded'},
        eventId: 'event_1',
        sessionId: 'session_01',
        seq: 1,
      ),
    );

    expect(state().busy, isFalse);
    expect(state().lastRunStatus?.name, 'succeeded');
  });

  test('cancels the active run with its runId', () async {
    controller().updateDraft('hello');
    final future = controller().sendText();
    await pumpEventQueue();
    socket.emitMessage(
      commandResult(commandId: lastCommandId(socket), data: {'runId': 'run_01'}),
    );
    await future;

    final cancel = controller().cancelActiveRun();
    await pumpEventQueue();

    expect(lastCommandType(socket), 'run.cancel');
    expect(jsonDecode(socket.sent.last), containsPair('runId', 'run_01'));
    expect(state().cancelling, isTrue);

    socket.emitMessage(commandResult(commandId: lastCommandId(socket)));
    await cancel;

    // 取消请求成功不代表 run 已终态，仍需等待 run.completed。
    expect(state().cancelling, isTrue);

    controller().mergeEvent(
      TimelineEvent(
        messageId: 'msg_2',
        timestamp: 2,
        type: 'run.completed',
        payload: {'status': 'cancelled'},
        eventId: 'event_2',
        sessionId: 'session_01',
        seq: 1,
      ),
    );

    expect(state().cancelling, isFalse);
    expect(state().busy, isFalse);
  });
}