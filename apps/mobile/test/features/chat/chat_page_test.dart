import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/connection_controller.dart';
import 'package:claude_remote/data/providers.dart';
import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/features/chat/chat_controller.dart';
import 'package:claude_remote/features/chat/chat_page.dart';
import 'package:claude_remote/features/chat/widgets/tool_card.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../connection/fake_socket.dart';

TimelineEvent event({
  required int seq,
  required String type,
  required Map<String, Object?> payload,
}) {
  return TimelineEvent(
    messageId: 'msg_$seq',
    timestamp: 1,
    type: type,
    payload: payload,
    eventId: 'event_$seq',
    sessionId: 'session_01',
    seq: seq,
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

  testWidgets('disables send while offline', (tester) async {
    final container = await pumpChat(tester);
    chatOf(container).attachSession('session_01');
    chatOf(container).updateDraft('hello');
    await tester.pump();

    final button = tester.widget<InkResponse>(
      find.byKey(const Key('composerSend')),
    );
    expect(button.onTap, isNull);
  });

  testWidgets('enables send once ready with a draft', (tester) async {
    final container = await pumpChat(tester);
    chatOf(container).attachSession('session_01');
    chatOf(container).setConnection(ConnectionStatus.ready);
    chatOf(container).updateDraft('hello');
    await tester.pump();

    final button = tester.widget<InkResponse>(
      find.byKey(const Key('composerSend')),
    );
    expect(button.onTap, isNotNull);
  });

  testWidgets('shows the stop control while a run is active', (tester) async {
    final container = await pumpChat(tester);
    chatOf(container).mergeSnapshot(
      SessionSnapshot.fromPayload({
        'activeRun': {'runId': 'run_01', 'status': 'running'},
        'lastSeq': 3,
      }),
    );
    await tester.pump();

    expect(find.text('停止'), findsOneWidget);
  });

  testWidgets('renders a denied tool card', (tester) async {
    final container = await pumpChat(tester);
    chatOf(container).mergeEvent(
      event(
        seq: 1,
        type: 'tool.started',
        payload: {'toolUseId': 'toolu_01', 'toolName': 'Bash', 'input': {}},
      ),
    );
    chatOf(container).mergeEvent(
      event(
        seq: 2,
        type: 'tool.completed',
        payload: {'toolUseId': 'toolu_01', 'status': 'denied'},
      ),
    );
    await tester.pump();

    expect(find.text('已拒绝'), findsOneWidget);
    expect(find.text('Bash'), findsOneWidget);
  });

  testWidgets('shows the snapshot truncation banner', (tester) async {
    final container = await pumpChat(tester);
    chatOf(container).mergeSnapshot(
      SessionSnapshot.fromPayload({
        'recentEvents': [],
        'lastSeq': 9,
        'snapshotTruncated': true,
      }),
    );
    await tester.pump();

    expect(find.textContaining('仅保留最近摘要'), findsOneWidget);
  });

  test('tool preview is capped at 256 KiB', () {
    final huge = 'x' * (maxToolPreviewChars + 10);
    final preview = toolPreview(huge);

    expect(preview.length, lessThan(huge.length));
    expect(preview, contains('已截断'));
  });
}