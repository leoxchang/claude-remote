import 'dart:io';

import 'package:claude_remote/recovery/cache_repository.dart';
import 'package:claude_remote/recovery/outbox_repository.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

CachedEvent event(String sessionId, int seq, {String text = 'message'}) {
  return CachedEvent(
    eventId: 'event_${sessionId}_$seq',
    sessionId: sessionId,
    seq: seq,
    payloadJson: '{"text":"$text","seq":$seq}',
    cachedAt: 1000 + seq,
  );
}

CachedSession session(String sessionId, {int activity = 0}) {
  return CachedSession(
    sessionId: sessionId,
    workspaceId: 'ws_1',
    title: 'Session $sessionId',
    status: 'idle',
    lastActivityAt: activity,
    cachedAt: activity,
  );
}

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfi;

  Future<RecoveryStore> openStore(Directory dir) {
    return RecoveryStore.open(
      factory: factory,
      supportDirectory: () async => dir,
    );
  }

  test('keeps at most 200 cached events per session', () async {
    final dir = await Directory.systemTemp.createTemp('s04-cache-events-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);

    await store.cache.putEvents('s1', [
      for (var seq = 1; seq <= 201; seq += 1) event('s1', seq),
    ]);
    final cached = await store.cache.readEvents('s1');
    expect(cached, hasLength(200));
    expect(cached.first.seq, 2);
    expect(cached.last.seq, 201);
  });

  test('keeps at most 10 sessions and drops evicted session events', () async {
    final dir = await Directory.systemTemp.createTemp('s04-cache-sessions-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);

    for (var index = 0; index < 11; index += 1) {
      final id = 's$index';
      await store.cache.putEvents(id, [event(id, 1)]);
      await store.cache.putSession(session(id, activity: index));
    }

    final sessions = await store.cache.readSessions();
    expect(sessions, hasLength(10));
    expect(sessions.map((entry) => entry.sessionId), isNot(contains('s0')));
    expect(await store.cache.readEvents('s0'), isEmpty);
    expect(await store.cache.readEvents('s10'), hasLength(1));
  });

  test('enforces the byte budget without pruning outbox, cursors or drafts',
      () async {
    final dir = await Directory.systemTemp.createTemp('s04-cache-bytes-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);
    final cache = CacheRepository(store.db, maxBytes: 900);

    await store.outbox.insert(
      OutboxCommand(
        commandId: 'cmd_keep',
        sessionId: 's1',
        type: 'prompt.send',
        payloadJson: '{"text":"pending"}',
        agentInstanceId: 'agent_1',
        state: OutboxState.persisted,
        createdAt: 1,
        updatedAt: 1,
      ),
    );
    await store.writeCursor(sessionId: 's1', lastContiguousSeq: 5);
    await store.saveDraft('s1', 'draft');

    await cache.putEvents('s1', [
      for (var seq = 1; seq <= 10; seq += 1)
        event('s1', seq, text: 'x' * 100),
    ]);
    expect(await cache.totalBytes(), lessThanOrEqualTo(900));
    expect((await cache.readEvents('s1')).length, lessThan(10));

    expect(await store.outbox.find('cmd_keep'), isNotNull);
    expect((await store.readCursor('s1'))?.lastContiguousSeq, 5);
    expect(await store.readDraft('s1'), 'draft');

    await store.clearAll();
    expect(await store.outbox.all(), isEmpty);
    expect(await store.readCursor('s1'), isNull);
    expect(await store.readDraft('s1'), isNull);
    expect(await store.cache.readEvents('s1'), isEmpty);
  });
}
