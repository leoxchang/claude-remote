import 'dart:io';

import 'package:claude_remote/recovery/recovery_database.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

const String _v1Schema = '''
CREATE TABLE outbox_commands (
  commandId TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  type TEXT NOT NULL,
  payloadJson TEXT,
  agentInstanceId TEXT,
  state TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX outbox_active_intent
ON outbox_commands (sessionId)
WHERE type IN ('prompt.send', 'run.requeue')
  AND state IN ('persisted', 'sending', 'awaiting_ack', 'confirmation_required');
CREATE TABLE sync_cursors (
  sessionId TEXT PRIMARY KEY,
  lastContiguousSeq INTEGER NOT NULL DEFAULT 0,
  lastSnapshotId TEXT,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE cached_events (
  eventId TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payloadJson TEXT NOT NULL,
  cachedAt INTEGER NOT NULL,
  UNIQUE (sessionId, seq)
);
CREATE INDEX cached_events_session ON cached_events (sessionId, seq);
CREATE TABLE cached_sessions (
  sessionId TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  lastActivityAt INTEGER NOT NULL,
  cachedAt INTEGER NOT NULL
);
CREATE TABLE drafts (
  sessionId TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);
''';

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfi;

  Future<Directory> prepareV1() async {
    final dir = await Directory.systemTemp.createTemp('s05-migration-');
    final path = p.join(dir.path, 'recovery.db');
    final db = await factory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 1,
        onCreate: (database, version) async {
          await database.execute(_v1Schema);
        },
      ),
    );
    await db.insert('outbox_commands', {
      'commandId': 'cmd_1',
      'sessionId': 'session_1',
      'type': 'prompt.send',
      'payloadJson': '{"text":"hi"}',
      'agentInstanceId': 'agent_1',
      'state': 'awaiting_ack',
      'createdAt': 1,
      'updatedAt': 1,
    });
    await db.insert('sync_cursors', {
      'sessionId': 'session_1',
      'lastContiguousSeq': 3,
      'lastSnapshotId': 'snap_1',
      'updatedAt': 1,
    });
    await db.insert('cached_events', {
      'eventId': 'event_1',
      'sessionId': 'session_1',
      'seq': 1,
      'payloadJson': '{"type":"message.completed"}',
      'cachedAt': 1,
    });
    await db.insert('cached_sessions', {
      'sessionId': 'session_1',
      'workspaceId': 'ws_1',
      'title': 'Session',
      'status': 'idle',
      'lastActivityAt': 1,
      'cachedAt': 1,
    });
    await db.insert('drafts', {
      'sessionId': 'session_1',
      'text': '草稿',
      'updatedAt': 1,
    });
    await db.close();
    return dir;
  }

  test('migrates v1 to v2 without losing any existing row', () async {
    final dir = await prepareV1();
    addTearDown(() => dir.delete(recursive: true));
    final store = await RecoveryStore.open(
      factory: factory,
      supportDirectory: () async => dir,
    );
    addTearDown(store.close);

    expect(recoverySchemaVersion, 4);
    for (final table in [
      'outbox_commands',
      'sync_cursors',
      'cached_events',
      'cached_sessions',
      'drafts',
    ]) {
      final rows = await store.db.query(table);
      expect(rows, hasLength(1), reason: table);
    }
    final voiceRows = await store.db.query('voice_drafts');
    expect(voiceRows, isEmpty);
    final userRows = await store.db.query('user_messages');
    expect(userRows, isEmpty);
  });

  test('creates only the voice draft columns with pending status', () async {
    final dir = await prepareV1();
    addTearDown(() => dir.delete(recursive: true));
    final store = await RecoveryStore.open(
      factory: factory,
      supportDirectory: () async => dir,
    );
    addTearDown(store.close);

    final columns = await store.db.rawQuery(
      'PRAGMA table_info(voice_drafts)',
    );
    expect(
      columns.map((row) => row['name']).toList(),
      [
        'voiceDraftId',
        'asrStreamId',
        'originSessionId',
        'originalDraft',
        'combinedDraft',
        'status',
        'createdAt',
      ],
    );
    expect(
      columns.map((row) => row['name']).where(
        (name) =>
            '$name'.contains('partial') ||
            '$name'.contains('audio') ||
            '$name'.contains('apiKey'),
      ),
      isEmpty,
    );

    await expectLater(
      store.db.insert('voice_drafts', {
        'voiceDraftId': 'draft_bad',
        'asrStreamId': 'asr_1',
        'originSessionId': 'session_1',
        'originalDraft': '',
        'combinedDraft': 'x',
        'status': 'consumed',
        'createdAt': 1,
      }),
      throwsA(anything),
    );
  });
}