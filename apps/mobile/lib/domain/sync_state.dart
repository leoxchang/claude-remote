import 'dart:convert';

import '../protocol/messages.dart';

/// 单个事件的合并结论。
enum SyncApplyOutcome {
  applied,
  duplicate,
  buffered,
  conflict,
  overflow,
}

final class SyncUpdate {
  const SyncUpdate(
    this.state,
    this.outcome, {
    this.applied = const <TimelineEvent>[],
  });

  final SyncState state;
  final SyncApplyOutcome outcome;
  /// 本次真正推进连续游标的事件（含从缓冲补上的）。
  final List<TimelineEvent> applied;
}

/// 每 session 的连续 seq 与乱序缓冲。
final class SyncState {
  const SyncState({
    this.lastContiguousSeq = 0,
    this.pendingBySeq = const <int, TimelineEvent>{},
    this.appliedEventIds = const <String, int>{},
    this.syncing = false,
  });

  static const int maxPendingEvents = 200;
  static const int maxPendingBytes = 2 * 1024 * 1024;

  final int lastContiguousSeq;
  final Map<int, TimelineEvent> pendingBySeq;
  final Map<String, int> appliedEventIds;
  final bool syncing;

  SyncState copyWith({
    int? lastContiguousSeq,
    Map<int, TimelineEvent>? pendingBySeq,
    Map<String, int>? appliedEventIds,
    bool? syncing,
  }) {
    return SyncState(
      lastContiguousSeq: lastContiguousSeq ?? this.lastContiguousSeq,
      pendingBySeq: pendingBySeq ?? this.pendingBySeq,
      appliedEventIds: appliedEventIds ?? this.appliedEventIds,
      syncing: syncing ?? this.syncing,
    );
  }

  /// 只有 seq=cursor+1 才推进；乱序进入有界缓冲。
  SyncUpdate applyLive(TimelineEvent event) {
    final knownSeq = appliedEventIds[event.eventId];
    if (knownSeq != null) {
      return SyncUpdate(
        this,
        knownSeq == event.seq
            ? SyncApplyOutcome.duplicate
            : SyncApplyOutcome.conflict,
      );
    }
    final sameSeq = pendingBySeq[event.seq];
    if (sameSeq != null && sameSeq.eventId != event.eventId) {
      return SyncUpdate(this, SyncApplyOutcome.conflict);
    }
    if (event.seq <= lastContiguousSeq) {
      return SyncUpdate(this, SyncApplyOutcome.conflict);
    }
    if (event.seq == lastContiguousSeq + 1) {
      final applied = _applyContiguous(event);
      return SyncUpdate(
        applied.state,
        SyncApplyOutcome.applied,
        applied: applied.events,
      );
    }
    if (pendingBySeq.length >= maxPendingEvents ||
        _pendingBytes() + _eventBytes(event) > maxPendingBytes) {
      return SyncUpdate(this, SyncApplyOutcome.overflow);
    }
    return SyncUpdate(
      copyWith(
        pendingBySeq: Map<int, TimelineEvent>.unmodifiable({
          ...pendingBySeq,
          event.seq: event,
        }),
      ),
      SyncApplyOutcome.buffered,
    );
  }

  /// 快照应用后重置连续游标；旧 lastSeq 不允许回退。
  SyncState afterSnapshot({
    required int lastSeq,
    required List<TimelineEvent> events,
  }) {
    if (lastSeq < lastContiguousSeq) return this;
    var state = copyWith(
      lastContiguousSeq: lastSeq,
      pendingBySeq: const <int, TimelineEvent>{},
      appliedEventIds: Map<String, int>.unmodifiable({
        ...appliedEventIds,
        for (final event in events) event.eventId: event.seq,
      }),
    );
    for (final seq in (pendingBySeq.keys.toList()..sort())) {
      final event = pendingBySeq[seq];
      if (event == null || event.seq <= state.lastContiguousSeq) continue;
      state = state.applyLive(event).state;
    }
    return state;
  }

  SyncState clearPending() {
    return copyWith(pendingBySeq: const <int, TimelineEvent>{});
  }

  SyncState withSyncing(bool value) => copyWith(syncing: value);

  ({SyncState state, List<TimelineEvent> events}) _applyContiguous(
    TimelineEvent first,
  ) {
    var cursor = first.seq;
    final ids = <String, int>{...appliedEventIds, first.eventId: first.seq};
    final pending = <int, TimelineEvent>{...pendingBySeq};
    final applied = <TimelineEvent>[first];
    while (true) {
      final next = pending.remove(cursor + 1);
      if (next == null) break;
      cursor = next.seq;
      applied.add(next);
      ids[next.eventId] = next.seq;
    }
    return (
      state: copyWith(
        lastContiguousSeq: cursor,
        pendingBySeq: Map<int, TimelineEvent>.unmodifiable(pending),
        appliedEventIds: Map<String, int>.unmodifiable(ids),
      ),
      events: applied,
    );
  }

  int _pendingBytes() {
    return pendingBySeq.values.fold<int>(
      0,
      (total, event) => total + _eventBytes(event),
    );
  }

  int _eventBytes(TimelineEvent event) {
    return utf8.encode(
      jsonEncode({
        'eventId': event.eventId,
        'seq': event.seq,
        'payload': event.payload,
      }),
    ).length;
  }
}