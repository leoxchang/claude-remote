import '../domain/snapshot_assembler.dart';
import '../domain/sync_state.dart';
import '../protocol/messages.dart';
import '../protocol/s04_messages.dart';
import 'dart:async';
import 'dart:convert';

import '../recovery/cache_repository.dart';

/// 取一页 afterSeq；服务端 RESYNC_REQUIRED 由调用方转成 [SyncResyncRequired]。
typedef SyncPageFetcher = Future<SyncPageMessage> Function(
  int afterSeq,
  int limit,
);

/// 取一页快照；snapshotId/pageIndex 为空表示新建/第 0 页。
typedef SnapshotPageFetcher = Future<SnapshotPageMessage> Function(
  String? snapshotId,
  int? pageIndex,
);

/// 服务端要求全量重同步；只携带 manifest。
final class SyncResyncRequired implements Exception {
  const SyncResyncRequired({
    required this.snapshotId,
    required this.pageCount,
  });

  final String snapshotId;
  final int pageCount;
}

final class SyncResult {
  const SyncResult({
    required this.events,
    required this.lastSeq,
    required this.resyncRequired,
  });

  final List<TimelineEvent> events;
  final int lastSeq;
  final bool resyncRequired;
}

/// App 侧同步协调器：连续 seq、乱序缓冲与原子快照应用。
final class SessionSyncCoordinator {
  SessionSyncCoordinator({
    required SyncPageFetcher syncPage,
    required SnapshotPageFetcher snapshotPage,
    required void Function(SnapshotAssembly assembly) applySnapshot,
    required void Function(TimelineEvent event) applyEvent,
    void Function(String sessionId, int lastSeq)? onCursor,
    CacheRepository? cache,
    SnapshotAssembler? assembler,
    void Function(String sessionId, Map<String, Object?> page)? onStatePage,
  }) : _syncPage = syncPage,
       _snapshotPage = snapshotPage,
       _applySnapshot = applySnapshot,
       _applyEvent = applyEvent,
       _onCursor = onCursor,
       _cache = cache,
       _assembler = assembler ?? SnapshotAssembler(),
       _onStatePage = onStatePage;

  final SyncPageFetcher _syncPage;
  final SnapshotPageFetcher _snapshotPage;
  final void Function(SnapshotAssembly assembly) _applySnapshot;
  final void Function(TimelineEvent event) _applyEvent;
  final void Function(String sessionId, int lastSeq)? _onCursor;
  final CacheRepository? _cache;
  final SnapshotAssembler _assembler;
  final void Function(String sessionId, Map<String, Object?> page)? _onStatePage;
  final Map<String, SyncState> _states = {};
  final Map<String, SyncVolatileSummary?> _volatile = {};
  final Set<String> _needsResync = {};

  SyncState stateOf(String sessionId) =>
      _states[sessionId] ?? const SyncState();

  SyncVolatileSummary? volatileOf(String sessionId) => _volatile[sessionId];

  bool needsResync(String sessionId) => _needsResync.contains(sessionId);

  /// 冷启动时用持久游标初始化；必须早于第一次 sync/applyLive。
  void seedCursor(String sessionId, int lastContiguousSeq) {
    _states[sessionId] = SyncState(lastContiguousSeq: lastContiguousSeq);
  }

  SyncState _state(String sessionId) {
    return _states.putIfAbsent(sessionId, () => const SyncState());
  }

  void _set(String sessionId, SyncState state) {
    _states[sessionId] = state;
  }

  /// 从持久游标开始拉取直到 hasMore=false；每页事件按 seq 合并。
  Future<SyncResult> sync(String sessionId, {int limit = 100}) async {
    _set(sessionId, _state(sessionId).withSyncing(true));
    final collected = <TimelineEvent>[];
    var cursor = _state(sessionId).lastContiguousSeq;
    var lastSeq = cursor;
    try {
      while (true) {
        final SyncPageMessage page;
        try {
          page = await _syncPage(cursor, limit);
        } on SyncResyncRequired {
          return SyncResult(
            events: collected,
            lastSeq: cursor,
            resyncRequired: true,
          );
        }
        lastSeq = page.lastSeq;
        for (final event in page.events) {
          final update = _state(sessionId).applyLive(event);
          _set(sessionId, update.state);
          if (update.outcome == SyncApplyOutcome.conflict ||
              update.outcome == SyncApplyOutcome.overflow) {
            await clearConflict(sessionId);
            _needsResync.add(sessionId);
            return SyncResult(
              events: collected,
              lastSeq: cursor,
              resyncRequired: true,
            );
          }
          for (final applied in update.applied) {
            collected.add(applied);
            _applyEvent(applied);
            await _cacheEvent(applied);
          }
        }
        cursor = page.nextAfterSeq;
        _volatile[sessionId] = page.volatile;
        _onCursor?.call(sessionId, cursor);
        if (!page.hasMore) break;
      }
      return SyncResult(
        events: collected,
        lastSeq: lastSeq,
        resyncRequired: false,
      );
    } finally {
      _set(sessionId, _state(sessionId).withSyncing(false));
    }
  }

  /// 直播事件；乱序时只缓冲，不渲染到达顺序。
  SyncApplyOutcome applyLive(TimelineEvent event) {
    final update = _state(event.sessionId).applyLive(event);
    _set(event.sessionId, update.state);
    if (update.outcome == SyncApplyOutcome.conflict ||
        update.outcome == SyncApplyOutcome.overflow) {
      _needsResync.add(event.sessionId);
      unawaited(clearConflict(event.sessionId));
      return update.outcome;
    }
    for (final applied in update.applied) {
      _applyEvent(applied);
      unawaited(_cacheEvent(applied));
    }
    return update.outcome;
  }

  /// 收齐所有页后一次性应用；旧 lastSeq 不覆盖较新状态。
  Future<bool> applySnapshotPage(SnapshotPageMessage page) async {
    final assembly = _assembler.add(page);
    if (assembly == null) return false;
    final current = _state(assembly.sessionId);
    if (assembly.lastSeq < current.lastContiguousSeq) return false;
    final after = current.afterSnapshotWithEvents(
      lastSeq: assembly.lastSeq,
      events: assembly.events,
    );
    _set(assembly.sessionId, after.state);
    _applySnapshot(assembly);
    for (final event in after.applied) {
      _applyEvent(event);
      await _cacheEvent(event);
    }
    _needsResync.remove(assembly.sessionId);
    _onCursor?.call(assembly.sessionId, assembly.lastSeq);
    return true;
  }

  /// eventId/seq 冲突：清该 session 缓存并要求全量重同步。
  Future<void> clearConflict(String sessionId) async {
    _set(
      sessionId,
      const SyncState(syncing: true),
    );
    _volatile.remove(sessionId);
    await _cache?.clearSession(sessionId);
    _needsResync.add(sessionId);
  }

  Future<void> _cacheEvent(TimelineEvent event) async {
    await _cache?.putEvents(event.sessionId, [
      CachedEvent(
        eventId: event.eventId,
        sessionId: event.sessionId,
        seq: event.seq,
        payloadJson: jsonEncode(event.toWire()),
        cachedAt: DateTime.now().millisecondsSinceEpoch,
      ),
    ]);
  }

  /// 只取第 0 页安全状态（recovery/queued/pending），不覆盖时间线。
  Future<void> refreshStatePage(String sessionId) async {
    final page = await _snapshotPage(null, 0);
    _onStatePage?.call(page.sessionId, page.payload);
  }

  /// 全量快照流程：从第 0 页开始逐页拉取，直到应用或出错。
  Future<bool> resyncSnapshot(String sessionId) async {
    String? snapshotId;
    var pageIndex = 0;
    while (true) {
      final page = await _snapshotPage(snapshotId, pageIndex);
      snapshotId = page.snapshotId;
      final applied = await applySnapshotPage(page);
      if (applied) return true;
      pageIndex += 1;
      if (pageIndex >= page.pageCount) return false;
    }
  }
}