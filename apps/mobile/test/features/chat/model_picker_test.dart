import 'dart:convert';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/data/providers.dart';
import 'package:claude_remote/domain/model_option.dart';
import 'package:claude_remote/features/chat/chat_controller.dart';
import 'package:claude_remote/features/chat/chat_page.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../connection/fake_socket.dart';

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

  // 清单内容只来自测试注入（模拟 models.list 结果），App 不内置。
  ModelCatalog catalog() => const ModelCatalog(
    models: [
      ModelOption(value: 'opus', displayName: 'Opus 5', description: '深度推理'),
      ModelOption(value: 'sonnet', displayName: 'Sonnet 5'),
    ],
  );

  Future<ProviderContainer> pumpChat(
    WidgetTester tester, {
    ModelCatalog? models,
  }) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          commandClientProvider.overrideWith((ref) async => client),
          chatSessionRuntimeProvider.overrideWith((ref) async => null),
          if (models != null)
            modelCatalogProvider.overrideWith(
              (ref, workspaceId) async => models,
            ),
        ],
        child: const MaterialApp(home: ChatPage()),
      ),
    );
    return ProviderScope.containerOf(tester.element(find.byType(ChatPage)));
  }

  ChatController chatOf(ProviderContainer container) =>
      container.read(chatControllerProvider.notifier);

  Map<String, dynamic> lastSentOf(String type) {
    final matches = socket.sent
        .map((wire) => jsonDecode(wire) as Map<String, dynamic>)
        .where((message) => message['type'] == type)
        .toList();
    return matches.isEmpty ? <String, dynamic>{} : matches.last;
  }

  testWidgets('chip shows 默认 when the session follows the Mac default', (
    tester,
  ) async {
    final container = await pumpChat(tester);
    chatOf(container).attachSession('session_01');
    await tester.pump();

    expect(find.text('默认'), findsOneWidget);
  });

  testWidgets('chip shows the catalog display name', (tester) async {
    final container = await pumpChat(tester, models: catalog());
    chatOf(container)
        .attachSession('session_01', model: 'opus', workspaceId: 'ws_a');
    await tester.pumpAndSettle();

    expect(find.text('Opus 5'), findsOneWidget);
  });

  testWidgets('archived sessions do not open the picker', (tester) async {
    final container = await pumpChat(tester, models: catalog());
    chatOf(container)
        .attachSession('session_01', model: 'opus', workspaceId: 'ws_a');
    chatOf(container).mergeEvent(
      TimelineEvent(
        messageId: 'msg_archived',
        timestamp: 1,
        type: 'session.status',
        payload: {'state': 'archived'},
        eventId: 'event_archived',
        sessionId: 'session_01',
        seq: 1,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('modelChip')));
    await tester.pumpAndSettle();

    expect(find.text('默认（跟随 Mac）'), findsNothing);
  });

  testWidgets('selecting a model sends session.set-model', (tester) async {
    final container = await pumpChat(tester, models: catalog());
    chatOf(container)
        .attachSession('session_01', model: 'opus', workspaceId: 'ws_a');
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('modelChip')));
    await tester.pumpAndSettle();
    expect(find.text('默认（跟随 Mac）'), findsOneWidget);

    await tester.tap(find.text('默认（跟随 Mac）'));
    await tester.pump();

    final sent = lastSentOf('session.set-model');
    expect(sent, isNotEmpty);
    final payload = sent['payload'] as Map<String, dynamic>;
    expect(payload['model'], isNull);

    // 回填 command.result，避免请求超时定时器悬挂。
    socket.emitMessage(commandResult(commandId: sent['commandId'] as String));
    await tester.pump();
  });
}
