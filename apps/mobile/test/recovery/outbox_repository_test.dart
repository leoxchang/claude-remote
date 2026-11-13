import 'dart:io';

import 'package:claude_remote/recovery/outbox_repository.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfi;

  Future<RecoveryStore> openStore(Directory dir) {
    return RecoveryStore.open(
      factory: factory,
      supportDirectory: () async => dir,
    );
  }

  OutboxCommand command(
    String id, {
    String session = 's1',
    String type = 'prompt.send',
    OutboxState state = OutboxState.persisted,
  }) {
    return OutboxCommand(
      commandId: id,
      sessionId: session,
      type: type,
      payloadJson: '{"text":"$id"}',
      agentInstanceId: 'agent_1',
      state: state,
      createdAt: 1,
      updatedAt: 1,
    );
  }

  test('blocks only execution intents and survives reopen', () async {
    final dir = await Directory.systemTemp.createTemp('s04-outbox-repo-');
    addTearDown(() => dir.delete(recursive: true));
    final first = await openStore(dir);
    await first.outbox.insert(command('cmd_prompt'));
    await first.outbox.insert(
      command('cmd_sync', type: 'session.sync', session: 's2'),
    );
    await first.outbox.insert(
      command('cmd_requeue', type: 'run.requeue', session: 's3'),
    );
    await expectLater(
      first.outbox.insert(command('cmd_other')),
      throwsA(isA<Exception>()),
    );
    expect(await first.outbox.hasExecutionIntent('s2'), isFalse);
    expect(await first.outbox.hasExecutionIntent('s3'), isTrue);
    await first.close();

    final second = await openStore(dir);
    addTearDown(second.close);
    expect(await second.outbox.hasExecutionIntent('s1'), isTrue);
    expect((await second.outbox.activeIntentForSession('s1'))?.commandId,
        'cmd_prompt');
    await second.outbox.clearPayload('cmd_prompt');
    expect(await second.outbox.hasExecutionIntent('s1'), isFalse);
    expect((await second.outbox.find('cmd_prompt'))?.payloadJson, isNull);
    expect(
      (await second.outbox.find('cmd_prompt'))?.state,
      OutboxState.completed,
    );
  });

  test('discarded tombstones release the gate without keeping payload', () async {
    final dir = await Directory.systemTemp.createTemp('s04-outbox-discard-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);

    await store.outbox.insert(command('cmd_1'));
    await store.outbox.clearPayload('cmd_1', state: OutboxState.discarded);
    final row = await store.outbox.find('cmd_1');
    expect(row?.state, OutboxState.discarded);
    expect(row?.payloadJson, isNull);
    expect(await store.outbox.hasExecutionIntent('s1'), isFalse);
    await store.outbox.insert(command('cmd_2'));
    expect(await store.outbox.hasExecutionIntent('s1'), isTrue);
  });
}
