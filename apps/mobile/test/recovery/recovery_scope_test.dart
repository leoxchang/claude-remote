import 'dart:io';

import 'package:claude_remote/recovery/recovery_database.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();

  test('legacy unscoped stores keep the original file name', () {
    expect(recoveryFileNameFor(null), 'recovery.db');
    expect(recoveryFileNameFor('cloud-dev_a'), 'recovery-cloud-dev_a.db');
  });

  test('scoped stores use distinct files and never share rows', () async {
    final dir = await Directory.systemTemp.createTemp('relay-scope-');
    addTearDown(() => dir.delete(recursive: true));
    final a = await RecoveryStore.open(
      factory: databaseFactoryFfi,
      supportDirectory: () async => dir,
      fileName: recoveryFileNameFor('cloud-dev_a'),
    );
    final b = await RecoveryStore.open(
      factory: databaseFactoryFfi,
      supportDirectory: () async => dir,
      fileName: recoveryFileNameFor('cloud-dev_b'),
    );
    addTearDown(a.close);
    addTearDown(b.close);

    expect(File('${dir.path}/recovery-cloud-dev_a.db').existsSync(), isTrue);
    expect(File('${dir.path}/recovery-cloud-dev_b.db').existsSync(), isTrue);
    expect(File('${dir.path}/recovery.db').existsSync(), isFalse);

    await a.saveDraft('s1', 'draft-a');
    expect(await b.readDraft('s1'), isNull);
    await b.writeCursor(sessionId: 's1', lastContiguousSeq: 7);
    expect(await a.readCursor('s1'), isNull);
    expect(await b.readCursor('s1'), isNotNull);
  });
}
