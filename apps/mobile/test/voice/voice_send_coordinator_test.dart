import 'dart:io';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/persistent_command_coordinator.dart';
import 'package:claude_remote/data/agent_socket.dart' show JsonMap;
import 'package:claude_remote/recovery/outbox_repository.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:claude_remote/voice/voice_draft.dart';
import 'package:claude_remote/voice/voice_draft_repository.dart';
import 'package:claude_remote/voice/voice_send_coordinator.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class ThrowingDrafts implements VoiceDraftStore {
  @override
  Future<VoiceDraft> commitFinal({
    required String voiceDraftId,
    required String asrStreamId,
    required String originSessionId,
    required String originalDraft,
    required String finalText,
  }) async {
    throw UnimplementedError();
  }

  @override
  Future<void> deleteWithin(Transaction txn, String voiceDraftId) async {
    throw StateError('delete failed');
  }

  @override
  Future<void> restoreOriginal(String voiceDraftId) async {}

  @override
  Future<VoiceDraft> updateCombinedDraft(
    String voiceDraftId,
    String combinedDraft,
  ) async {
    throw UnimplementedError();
  }
}

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfi;

  late Directory dir;
  late RecoveryStore store;
  late List<JsonMap> delivered;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('s05-send-');
    store = await RecoveryStore.open(
      factory: factory,
      supportDirectory: () async => dir,
    );
    delivered = [];
  });

  tearDown(() async {
    await store.close();
    await dir.delete(recursive: true);
  });

  PersistentCommandCoordinator commands() {
    return PersistentCommandCoordinator(
      outbox: store.outbox,
      deliver: (snapshot) async {
        delivered.add(JsonMap.from({'accepted': true}));
        return JsonMap.from({'accepted': true});
      },
      schedule: (duration, callback) => () {},
    );
  }

  CommandRequest<JsonMap> prompt(String commandId, String text) {
    return CommandRequest<JsonMap>(
      commandId: commandId,
      traceId: 'trace_$commandId',
      type: 'prompt.send',
      sessionId: 'session_1',
      payload: {'text': text},
      decode: (data) => data,
    );
  }

  Future<void> seedDraft() async {
    await store.saveDraft('session_1', '原草稿');
    await store.voiceDrafts.commitFinal(
      voiceDraftId: 'vd_1',
      asrStreamId: 'asr_1',
      originSessionId: 'session_1',
      originalDraft: '原草稿',
      finalText: '识别文本。',
    );
  }

  test('deletes the voice draft in the same outbox transaction', () async {
    await seedDraft();
    final coordinator = VoiceSendCoordinator(
      commands: commands(),
      drafts: store.voiceDrafts,
    );
    final result = await coordinator.sendPrompt(
      request: prompt('cmd_1', '原草稿\n识别文本。'),
      voiceDraftId: 'vd_1',
    );
    expect(result['accepted'], isTrue);
    expect(await store.voiceDrafts.find('vd_1'), isNull);
    expect(delivered, hasLength(1));
    final row = await store.outbox.find('cmd_1');
    expect(row?.state.name, 'awaitingAck');
  });

  test('rolls back both rows when the draft deletion fails', () async {
    await seedDraft();
    final coordinator = VoiceSendCoordinator(
      commands: commands(),
      drafts: ThrowingDrafts(),
    );
    await expectLater(
      coordinator.sendPrompt(
        request: prompt('cmd_2', '原草稿\n识别文本。'),
        voiceDraftId: 'vd_1',
      ),
      throwsA(isA<StateError>()),
    );
    expect(await store.outbox.find('cmd_2'), isNull);
    expect(await store.voiceDrafts.find('vd_1'), isNotNull);
    expect(delivered, isEmpty);
  });

  test('keeps S04 behavior when no voice draft is attached', () async {
    await seedDraft();
    final coordinator = VoiceSendCoordinator(
      commands: commands(),
      drafts: store.voiceDrafts,
    );
    await coordinator.sendPrompt(request: prompt('cmd_3', '普通文本'));
    expect(await store.voiceDrafts.find('vd_1'), isNotNull);
    expect(delivered, hasLength(1));
  });

  test('a repeated commandId never produces a second prompt', () async {
    await seedDraft();
    final persistent = commands();
    final coordinator = VoiceSendCoordinator(
      commands: persistent,
      drafts: store.voiceDrafts,
    );
    await coordinator.sendPrompt(
      request: prompt('cmd_4', '一'),
      voiceDraftId: 'vd_1',
    );
    await persistent.onConfirmed('cmd_4');
    await expectLater(
      coordinator.sendPrompt(
        request: prompt('cmd_4', '一'),
        voiceDraftId: 'vd_1',
      ),
      throwsA(isA<CommandFailure>()),
    );
    expect(delivered, hasLength(1));
  });

  test('confirmation_required keeps the voice draft', () async {
    await seedDraft();
    final persistent = commands();
    await persistent.send(
      commandId: 'cmd_5',
      sessionId: 'session_1',
      type: 'prompt.send',
      payload: const {'text': '旧实例'},
    );
    await store.outbox.updateState(
      'cmd_5',
      OutboxState.confirmationRequired,
    );
    final coordinator = VoiceSendCoordinator(
      commands: persistent,
      drafts: store.voiceDrafts,
    );
    await expectLater(
      coordinator.sendPrompt(
        request: prompt('cmd_5', '旧实例'),
        voiceDraftId: 'vd_1',
      ),
      throwsA(isA<CommandFailure>()),
    );
    expect(await store.voiceDrafts.find('vd_1'), isNotNull);
  });
}