import 'dart:io';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/connection_controller.dart';
import 'package:claude_remote/connection/persistent_command_coordinator.dart';
import 'package:claude_remote/data/agent_socket.dart' show JsonMap;
import 'package:claude_remote/data/providers.dart';
import 'package:claude_remote/features/chat/chat_controller.dart';
import 'package:claude_remote/features/chat/chat_page.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:claude_remote/voice/voice_draft.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../../connection/fake_socket.dart';

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfi;

  late Directory dir;
  late RecoveryStore store;
  late FakeAgentSocket socket;
  late CommandClient client;
  late ProviderContainer container;
  late List<JsonMap> delivered;

  ChatController controller() => container.read(chatControllerProvider.notifier);

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('s05-composer-');
    store = await RecoveryStore.open(
      factory: factory,
      supportDirectory: () async => dir,
    );
    socket = FakeAgentSocket();
    client = CommandClient(socket);
    delivered = [];
    container = ProviderContainer(
      overrides: [
        commandClientProvider.overrideWith((ref) async => client),
      ],
    );
    final chat = controller();
    chat.attachSession('session_1');
    chat.setConnection(ConnectionStatus.ready);
    chat.attachVoiceDrafts(store.voiceDrafts);
  });

  tearDown(() async {
    await client.dispose();
    await socket.close();
    await store.close();
    await dir.delete(recursive: true);
    container.dispose();
  });

  PersistentCommandCoordinator persistent() {
    return PersistentCommandCoordinator(
      outbox: store.outbox,
      deliver: (snapshot) async {
        delivered.add(JsonMap.from(snapshot.payload));
        return JsonMap.from({
          'sessionId': 'session_1',
          'runId': 'run_1',
          'status': 'queued',
        });
      },
      schedule: (duration, callback) => () {},
    );
  }

  Future<void> seedVoiceDraft() async {
    await store.saveDraft('session_1', '原草稿');
    await store.voiceDrafts.commitFinal(
      voiceDraftId: 'vd_1',
      asrStreamId: 'asr_1',
      originSessionId: 'session_1',
      originalDraft: '原草稿',
      finalText: '识别文本。',
    );
  }

  Future<void> seedPendingDraft() async {
    await store.saveDraft('session_1', '原草稿');
    await store.voiceDrafts.commitFinal(
      voiceDraftId: 'vd_pending',
      asrStreamId: 'asr_pending',
      originSessionId: 'session_1',
      originalDraft: '原草稿',
      finalText: '识别文本。',
    );
  }

  Future<void> waitFor(bool Function() predicate) async {
    for (var attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    fail('condition was not met');
  }

  test('recording does not require an existing draft', () {
    const idle = ChatState(connection: ConnectionStatus.ready);
    expect(idle.canRecordVoice, isTrue);
    expect(idle.canSend, isFalse);
    expect(
      idle.copyWith(connection: ConnectionStatus.disconnected).canRecordVoice,
      isFalse,
    );
    expect(idle.copyWith(archived: true).canRecordVoice, isFalse);
  });

  test('persists typed drafts and restores them on a fresh controller', () async {
    controller().attachComposerDrafts(store);
    controller().updateDraft('原草稿');
    for (var attempt = 0; attempt < 100; attempt += 1) {
      if (await store.readDraft('session_1') == '原草稿') break;
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    expect(await store.readDraft('session_1'), '原草稿');

    final restored = ProviderContainer(
      overrides: [
        commandClientProvider.overrideWith((ref) async => client),
      ],
    );
    addTearDown(restored.dispose);
    final chat = restored.read(chatControllerProvider.notifier);
    chat.attachComposerDrafts(store);
    chat.attachSession('session_1');
    await waitFor(() => chat.currentDraft == '原草稿');
    expect(chat.currentDraft, '原草稿');
  });

  test('adopts and discards a pending voice draft after restart', () async {
    await seedPendingDraft();
    final restored = ProviderContainer(
      overrides: [
        commandClientProvider.overrideWith((ref) async => client),
      ],
    );
    addTearDown(restored.dispose);
    final chat = restored.read(chatControllerProvider.notifier);
    chat.attachComposerDrafts(store);
    chat.attachVoiceDrafts(store.voiceDrafts);
    chat.attachSession('session_1');
    await waitFor(() => chat.state.pendingVoiceDraftId != null);
    expect(chat.state.pendingVoiceDraftId, 'vd_pending');
    expect(chat.currentDraft, '原草稿\n识别文本。');

    chat.updateDraft('原草稿\n识别文本，编辑。');
    VoiceDraft? edited;
    for (var attempt = 0; attempt < 100; attempt += 1) {
      edited = await store.voiceDrafts.find('vd_pending');
      if (edited?.combinedDraft == '原草稿\n识别文本，编辑。') break;
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    expect(edited?.combinedDraft, '原草稿\n识别文本，编辑。');

    await chat.discardPendingVoiceDraft();
    expect(chat.currentDraft, '原草稿');
    for (var attempt = 0; attempt < 100; attempt += 1) {
      if (await store.readDraft('session_1') == '原草稿') break;
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    expect(await store.readDraft('session_1'), '原草稿');
    expect(await store.voiceDrafts.find('vd_pending'), isNull);
    expect(chat.state.pendingVoiceDraftId, isNull);
  });

  testWidgets('shows a voice final inside the visible input field', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          commandClientProvider.overrideWith((ref) async => client),
          chatSessionRuntimeProvider.overrideWith((ref) async => null),
        ],
        child: const MaterialApp(home: ChatPage()),
      ),
    );
    final container = ProviderScope.containerOf(
      tester.element(find.byType(ChatPage)),
    );
    container.read(chatControllerProvider.notifier).updateDraft('识别文本');
    await tester.pump();
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.controller?.text, '识别文本');
  });

  test('sends the edited full draft and consumes the voice draft', () async {
    final commands = persistent();
    controller().attachPersistentCommands(commands);
    await seedVoiceDraft();
    controller().setPendingVoiceDraft('vd_1', sessionId: 'session_1');
    controller().updateDraft('原草稿\n识别文本，已编辑。');

    await controller().sendText();

    expect(delivered.single['text'], '原草稿\n识别文本，已编辑。');
    expect(await store.voiceDrafts.find('vd_1'), isNull);
    expect(await commands.pending(), isEmpty);
  });

  test('keeps plain text sending unchanged without a voice draft', () async {
    controller().attachPersistentCommands(persistent());
    controller().updateDraft('普通文本');

    await controller().sendText();

    expect(delivered.single['text'], '普通文本');
    expect(await store.voiceDrafts.pendingForSession('session_1'), isEmpty);
  });

  test('a pending draft only follows the session that sends it', () async {
    controller().attachPersistentCommands(persistent());
    await seedVoiceDraft();
    controller().setPendingVoiceDraft('vd_1', sessionId: 'session_1');
    controller().attachSession('session_2');
    controller().updateDraft('另一个会话');

    await controller().sendText();

    expect(delivered.single['text'], '另一个会话');
    expect(await store.voiceDrafts.find('vd_1'), isNotNull);
  });

  test('keeps the voice draft when the send is rejected', () async {
    final commands = persistent();
    controller().attachPersistentCommands(commands);
    await seedVoiceDraft();
    controller().setPendingVoiceDraft('vd_1', sessionId: 'session_1');
    await commands.send(
      commandId: 'cmd_other',
      sessionId: 'session_1',
      type: 'prompt.send',
      payload: const {'text': '阻塞'},
    );
    controller().updateDraft('识别文本。');

    await controller().sendText();

    expect(delivered, hasLength(1));
    expect(await store.voiceDrafts.find('vd_1'), isNotNull);
    expect(controller().state.error, isNotNull);
  });
}