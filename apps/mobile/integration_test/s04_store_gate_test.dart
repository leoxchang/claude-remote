import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

const MethodChannel _protection = MethodChannel(
  'claude_remote/s04_store_protection',
);

Future<Database> _open(String path, int version) {
  return openDatabase(
    path,
    version: version,
    onConfigure: (db) => db.execute('PRAGMA journal_mode = WAL'),
    onCreate: (db, _) async {
      await db.execute('CREATE TABLE gate (id TEXT PRIMARY KEY)');
    },
    onUpgrade: (db, from, to) async {
      await db.execute('CREATE TABLE gate_v2 (id TEXT PRIMARY KEY)');
    },
  );
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('recovery DB migrates, reopens and is Data Protected', (
    tester,
  ) async {
    final support = await getApplicationSupportDirectory();
    final path = p.join(support.path, 's04_store_gate.db');
    await deleteDatabase(path);

    var db = await _open(path, 1);
    await db.insert('gate', <String, Object?>{'id': 'v1'});
    await db.close();

    db = await _open(path, 2);
    expect(await db.query('gate'), hasLength(1));
    await db.insert('gate_v2', <String, Object?>{'id': 'v2'});
    await db.close();

    db = await _open(path, 2);
    expect(await db.query('gate_v2'), hasLength(1));

    final files = [path, '$path-wal', '$path-shm']
        .where((file) => File(file).existsSync())
        .toList();
    expect(files, contains(path));
    expect(files, contains('$path-wal'));

    final report = await _protection.invokeMapMethod<String, Object?>(
      'protectDatabase',
      <String, Object?>{'databasePath': path},
    );
    expect(report?['protected'], isTrue);
    expect(report?['files'], isA<List<Object?>>());
    expect((report?['files'] as List<Object?>), isNotEmpty);
    await db.close();
  });
}