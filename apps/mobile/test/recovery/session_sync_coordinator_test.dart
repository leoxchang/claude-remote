import 'dart:convert';
import 'dart:io';

import 'package:claude_remote/connection/session_sync_coordinator.dart';
import 'package:claude_remote/domain/snapshot_assembler.dart';
import 'package:claude_remote/domain/sync_state.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:claude_remote/protocol/s04_messages.dart';
import 'package:claude_remote/recovery/cache_repository.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

TimelineEvent event(int seq, {String? id}) {
  return TimelineEvent(
    messageId: 'msg_$seq',
    timestamp: seq,
    type: 'message.completed',
    payload: {'text': 'm$seq'},
    eventId: id ?? 'event_$seq',
    sessionId: 's1',
    seq: seq,
  );
}

SyncPageMessage page({
  required List<TimelineEvent> events,
  required int nextAfterSeq,
  required int lastSeq,
  required bool hasMore,
}) {
  return SyncPageMessage(
    events: events,
    nextAfterSeq: nextAfterSeq,
    lastSeq: lastSeq,
    hasMore: hasMore,
    volatile: hasMore
        ? null
        : const SyncVolatileSummary(
            activeRunId: null,
            activeStatus: null,
            pendingApprovalCount: 0,
            outcomeUnknown: false,
            eventTailMayBeIncomplete: false,
          ),
  );
}

String canonical(Object? value) {
  if (value == null || value is num || value is bool || value is String) {
    return jsonEncode(value);
  }
  if (value is List) return '[${value.map(canonical).join(',')}]';
  final map = value as Map;
  final keys = map.keys.map((key) => '$key').toList()..sort();
  return '{${keys.map((key) => '${jsonEncode(key)}:${canonical(map[key])}').join(',')}}';
}

SnapshotPageMessage snapshotPage(
  List<Map<String, Object?>> payloads,
  int index,
) {
  final bytes = utf8.encode(canonical(payloads));
  return SnapshotPageMessage(
    snapshotId: 'snap_1',
    sessionId: 's1',
    lastSeq: 5,
    pageIndex: index,
    pageCount: payloads.length,
    byteLength: bytes.length,
    sha256: sha256.convert(bytes).toString(),
    payload: payloads[index],
  );
}

void main() {
  sqfliteFfiInit();

  test('syncs pages in order and advances the cursor', () async {
    final cursors = <int>[];
    final applied = <int>[];
    final coordinator = SessionSyncCoordinator(
      syncPage: (afterSeq, limit) async {
        if (afterSeq == 0) {
          return page(
            events: [event(1), event(2)],
            nextAfterSeq: 2,
            lastSeq: 3,
            hasMore: true,
          );
        }
        return page(
          events: [event(3)],
          nextAfterSeq: 3,
          lastSeq: 3,
          hasMore: false,
        );
      },
      snapshotPage: (snapshotId, pageIndex) async =>
          throw UnimplementedError(),
      applySnapshot: (_) {},
      applyEvent: (event) => applied.add(event.seq),
      onCursor: (sessionId, lastSeq) => cursors.add(lastSeq),
    );

    final result = await coordinator.sync('s1');
    expect(result.resyncRequired, isFalse);
    expect(applied, [1, 2, 3]);
    expect(cursors, [2, 3]);
    expect(coordinator.stateOf('s1').lastContiguousSeq, 3);
    expect(coordinator.volatileOf('s1'), isNotNull);
  });

  test('buffers gaps, dedupes and detects conflicts', () {
    var applied = 0;
    final coordinator = SessionSyncCoordinator(
      syncPage: (afterSeq, limit) async => throw UnimplementedError(),
      snapshotPage: (snapshotId, pageIndex) async =>
          throw UnimplementedError(),
      applySnapshot: (_) {},
      applyEvent: (_) => applied += 1,
    );
    expect(
      coordinator.applyLive(event(1)),
      SyncApplyOutcome.applied,
    );
    expect(
      coordinator.applyLive(event(1)),
      SyncApplyOutcome.duplicate,
    );
    expect(
      coordinator.applyLive(event(3)),
      SyncApplyOutcome.buffered,
    );
    expect(
      coordinator.applyLive(event(3, id: 'other')),
      SyncApplyOutcome.conflict,
    );
    expect(coordinator.needsResync('s1'), isTrue);
    expect(coordinator.stateOf('s1').lastContiguousSeq, 0);
    // 冲突后必须全量重同步；重新按顺序应用才推进。
    expect(coordinator.applyLive(event(1)), SyncApplyOutcome.applied);
    expect(coordinator.applyLive(event(2)), SyncApplyOutcome.applied);
    expect(coordinator.applyLive(event(3)), SyncApplyOutcome.applied);
    expect(coordinator.stateOf('s1').lastContiguousSeq, 3);
    expect(applied, 4);

    for (var seq = 100; seq < 100 + SyncState.maxPendingEvents + 1; seq += 1) {
      final outcome = coordinator.applyLive(event(seq));
      if (seq == 100 + SyncState.maxPendingEvents) {
        expect(outcome, SyncApplyOutcome.overflow);
      }
    }
  });

  test('reports RESYNC_REQUIRED and applies a complete snapshot atomically', () async {
    final snapshots = <String>[];
    final payloads = <Map<String, Object?>>[
      {
        'lastSeq': 5,
        'session': {'sessionId': 's1', 'title': 'T'},
        'recentEvents': [
          {
            'protocolVersion': 1,
            'messageId': 'msg_1',
            'timestamp': 1,
            'type': 'message.completed',
            'eventId': 'event_1',
            'sessionId': 's1',
            'seq': 1,
            'payload': {'text': 'm1'},
          },
        ],
      },
      {'lastSeq': 5, 'recentEvents': []},
    ];
    final coordinator = SessionSyncCoordinator(
      syncPage: (afterSeq, limit) async =>
          throw const SyncResyncRequired(snapshotId: 'snap_1', pageCount: 2),
      snapshotPage: (snapshotId, pageIndex) async =>
          snapshotPage(payloads, pageIndex ?? 0),
      applySnapshot: (assembly) => snapshots.add(assembly.snapshotId),
      applyEvent: (_) {},
    );

    final result = await coordinator.sync('s1');
    expect(result.resyncRequired, isTrue);
    expect(await coordinator.resyncSnapshot('s1'), isTrue);
    expect(snapshots, ['snap_1']);
    expect(coordinator.stateOf('s1').lastContiguousSeq, 5);

    // 旧快照（lastSeq 更小）不覆盖本地较新状态。
    final olderPages = <Map<String, Object?>>[
      {'lastSeq': 1, 'recentEvents': []},
    ];
    final older = SnapshotPageMessage(
      snapshotId: 'snap_old',
      sessionId: 's1',
      lastSeq: 1,
      pageIndex: 0,
      pageCount: 1,
      byteLength: utf8.encode(canonical(olderPages)).length,
      sha256: sha256.convert(utf8.encode(canonical(olderPages))).toString(),
      payload: olderPages[0],
    );
    expect(await coordinator.applySnapshotPage(older), isFalse);
    expect(coordinator.stateOf('s1').lastContiguousSeq, 5);
  });

  test('clearConflict resets state and cache for the session', () async {
    final dir = await Directory.systemTemp.createTemp('s04-sync-conflict-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await RecoveryStore.open(
      factory: databaseFactoryFfi,
      supportDirectory: () async => dir,
    );
    addTearDown(store.close);
    await store.cache.putEvents('s1', [
      CachedEvent(
        eventId: 'event_1',
        sessionId: 's1',
        seq: 1,
        payloadJson: '{}',
        cachedAt: 1,
      ),
    ]);
    final coordinator = SessionSyncCoordinator(
      syncPage: (afterSeq, limit) async => throw UnimplementedError(),
      snapshotPage: (snapshotId, pageIndex) async =>
          throw UnimplementedError(),
      applySnapshot: (_) {},
      applyEvent: (_) {},
      cache: store.cache,
    );
    coordinator.applyLive(event(1));
    expect(coordinator.stateOf('s1').lastContiguousSeq, 1);
    await coordinator.clearConflict('s1');
    expect(coordinator.stateOf('s1').lastContiguousSeq, 0);
    expect(await store.cache.readEvents('s1'), isEmpty);
    expect(SnapshotAssembler(), isNotNull);
  });
}
