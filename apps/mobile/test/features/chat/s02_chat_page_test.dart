import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/connection_controller.dart';
import 'package:claude_remote/data/providers.dart';
import 'package:claude_remote/features/chat/chat_controller.dart';
import 'package:claude_remote/features/chat/chat_page.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../connection/fake_socket.dart';

TimelineEvent event({
  required int seq,
  required String type,
  String? runId,
  Map<String, Object?> payload = const <String, Object?>{},
}) {
  return TimelineEvent(
    messageId: 'msg_$seq',
    timestamp: 1,
    type: type,
    payload: payload,
    eventId: 'event_$seq',
    sessionId: 'session_01',
    seq: seq,
    runId: runId,
  );
}

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

  Future<ProviderContainer> pumpChat(WidgetTester tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          commandClientProvider.overrideWith((ref) async => client),
          chatSessionRuntimeProvider.overrideWith((ref) async => null),
        ],
        child: const MaterialApp(home: ChatPage()),
      ),
    );
    return ProviderScope.containerOf(tester.element(find.byType(ChatPage)));
  }

  ChatController chatOf(ProviderContainer container) =>
      container.read(chatControllerProvider.notifier);

  testWidgets('labels the send button as queue while a run is active', (
    tester,
  ) async {
    final container = await pumpChat(tester);
    chatOf(container).attachSession('session_01');
    chatOf(container).setConnection(ConnectionStatus.ready);
    chatOf(container).updateDraft('next');
    chatOf(container).mergeEvent(
      event(
        seq: 1,
        type: 'session.status',
        payload: {'state': 'running', 'activeRunId': 'run_active'},
      ),
    );
    await tester.pump();

    expect(find.byTooltip('排队'), findsOneWidget);
  });

  testWidgets('renders an anonymous queued card with removal and hint', (
    tester,
  ) async {
    final container = await pumpChat(tester);
    chatOf(container).mergeEvent(
      event(seq: 1, type: 'run.queued', runId: 'run_12345678', payload: {'enqueuedAt': 1}),
    );
    await tester.pump();

    expect(find.text('排队任务'), findsOneWidget);
    expect(find.textContaining('run_1234'), findsOneWidget);
    expect(find.text('执行结果未知'), findsNothing);
    expect(find.text('停止当前不会清除队列'), findsOneWidget);
    expect(find.byTooltip('移除'), findsOneWidget);
  });

  testWidgets('shows the stop hint next to the stop control', (tester) async {
    final container = await pumpChat(tester);
    chatOf(container).mergeEvent(
      event(
        seq: 1,
        type: 'session.status',
        payload: {'state': 'running', 'activeRunId': 'run_active'},
      ),
    );
    await tester.pump();

    expect(find.text('停止'), findsOneWidget);
    expect(find.text('停止当前不会清除队列'), findsOneWidget);
  });

  testWidgets('archived sessions disable the composer', (tester) async {
    final container = await pumpChat(tester);
    chatOf(container).attachSession('session_01');
    chatOf(container).setConnection(ConnectionStatus.ready);
    chatOf(container).updateDraft('hello');
    chatOf(container).mergeEvent(
      event(seq: 1, type: 'session.status', payload: {'state': 'archived'}),
    );
    await tester.pump();

    final button = tester.widget<InkResponse>(
      find.byKey(const Key('composerSend')),
    );
    expect(button.onTap, isNull);
  });
}