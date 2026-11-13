import 'dart:io';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/connection_controller.dart';
import 'package:claude_remote/connection/persistent_command_coordinator.dart';
import 'package:claude_remote/data/agent_socket.dart' show JsonMap;
import 'package:claude_remote/data/providers.dart';
import 'package:claude_remote/features/chat/chat_controller.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
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