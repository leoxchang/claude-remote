import 'dart:io';

import 'package:claude_remote/recovery/outbox_repository.dart';
import 'package:claude_remote/recovery/recovery_database.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
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

  test('creates recovery.db under the injected support directory', () async {
    final dir = await Directory.systemTemp.createTemp('s04-recovery-db-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);

    expect(File(p.join(dir.path, 'recovery.db')).existsSync(), isTrue);
    final tables = await store.db.query(
      'sqlite_master',
      columns: ['name'],
      where: "type = 'table'",
    );
    final names = tables.map((row) => row['name']).toSet();
    expect(
      names,
      containsAll(<String>[
        'outbox_commands',
        'sync_cursors',
        'cached_events',
        'cached_sessions',
        'drafts',
      ]),
    );
    expect(recoverySchemaVersion, 2);
  });

  test('enforces one active execution intent per session', () async {
    final dir = await Directory.systemTemp.createTemp('s04-outbox-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);

    Future<void> insert(String commandId, OutboxState state) {
      return store.outbox.insert(
        OutboxCommand(
          commandId: commandId,
          sessionId: 's1',
          type: 'prompt.send',
          payloadJson: '{"text":"hello"}',
          agentInstanceId: 'agent_1',
          state: state,
          createdAt: 1,
          updatedAt: 1,
        ),
      );
    }

    await insert('cmd_1', OutboxState.persisted);
    await expectLater(
      insert('cmd_2', OutboxState.confirmationRequired),
      throwsA(isA<Exception>()),
    );
    expect(await store.outbox.hasExecutionIntent('s1'), isTrue);
    expect(await store.outbox.hasExecutionIntent('s2'), isFalse);

    await store.outbox.clearPayload('cmd_1');
    expect(await store.outbox.find('cmd_1'), isNotNull);
    expect((await store.outbox.find('cmd_1'))?.payloadJson, isNull);
    await insert('cmd_3', OutboxState.persisted);
    expect(await store.outbox.activeIntentForSession('s1'), isNotNull);
  });

  test('restores drafts and cursors after reopen without token columns', () async {
    final dir = await Directory.systemTemp.createTemp('s04-reopen-');
    addTearDown(() => dir.delete(recursive: true));
    final first = await openStore(dir);
    await first.saveDraft('s1', 'draft text');
    await first.writeCursor(
      sessionId: 's1',
      lastContiguousSeq: 12,
      lastSnapshotId: 'snap_1',
    );
    await first.close();

    final second = await openStore(dir);
    addTearDown(second.close);
    expect(await second.readDraft('s1'), 'draft text');
    expect((await second.readCursor('s1'))?.lastContiguousSeq, 12);
    expect((await second.readCursor('s1'))?.lastSnapshotId, 'snap_1');

    for (final table in [
      'outbox_commands',
      'sync_cursors',
      'cached_events',
      'cached_sessions',
      'drafts',
    ]) {
      final columns = await second.db.rawQuery('PRAGMA table_info($table)');
      final names = columns.map((row) => row['name'] as String).join(',');
      expect(names.toLowerCase(), isNot(contains('token')));
      expect(names.toLowerCase(), isNot(contains('approvalcontent')));
      expect(names.toLowerCase(), isNot(contains('promptresponse')));
    }
  });
}