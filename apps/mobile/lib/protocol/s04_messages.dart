import '../data/agent_socket.dart' show JsonMap;
import 'messages.dart';

/// session.sync 的持久易失摘要；只在最后一页出现。
final class SyncVolatileSummary {
  const SyncVolatileSummary({
    required this.activeRunId,
    required this.activeStatus,
    required this.pendingApprovalCount,
    required this.outcomeUnknown,
    required this.eventTailMayBeIncomplete,
  });

  factory SyncVolatileSummary.fromWire(Map<String, Object?> wire) {
    final activeRunId = wire['activeRunId'];
    final activeStatus = wire['activeStatus'];
    final pending = wire['pendingApprovalCount'];
    return SyncVolatileSummary(
      activeRunId: activeRunId is String ? activeRunId : null,
      activeStatus: activeStatus is String ? activeStatus : null,
      pendingApprovalCount: pending is int ? pending : 0,
      outcomeUnknown: wire['outcomeUnknown'] == true,
      eventTailMayBeIncomplete: wire['eventTailMayBeIncomplete'] == true,
    );
  }

  final String? activeRunId;
  final String? activeStatus;
  final int pendingApprovalCount;
  final bool outcomeUnknown;
  final bool eventTailMayBeIncomplete;
}

/// session.sync 的一页；历史事件保持原 eventId/seq/timestamp。
final class SyncPageMessage {
  const SyncPageMessage({
    required this.events,
    required this.nextAfterSeq,
    required this.lastSeq,
    required this.hasMore,
    required this.volatile,
  });

  factory SyncPageMessage.fromWire(JsonMap wire) {
    final rawEvents = wire['events'];
    return SyncPageMessage(
      events: rawEvents is List
          ? rawEvents
              .whereType<Map<dynamic, dynamic>>()
              .map((event) => _event(event))
              .toList(growable: false)
          : const <TimelineEvent>[],
      nextAfterSeq: _int(wire, 'nextAfterSeq'),
      lastSeq: _int(wire, 'lastSeq'),
      hasMore: _bool(wire, 'hasMore'),
      volatile: wire['volatile'] is Map
          ? SyncVolatileSummary.fromWire(_wire(wire['volatile']))
          : null,
    );
  }

  final List<TimelineEvent> events;
  final int nextAfterSeq;
  final int lastSeq;
  final bool hasMore;
  final SyncVolatileSummary? volatile;
}

/// 分页快照的单页；页 0 携带安全/易失状态。
final class SnapshotPageMessage {
  const SnapshotPageMessage({
    required this.snapshotId,
    required this.sessionId,
    required this.lastSeq,
    required this.pageIndex,
    required this.pageCount,
    required this.byteLength,
    required this.sha256,
    required this.payload,
  });

  factory SnapshotPageMessage.fromWire(JsonMap wire) {
    final page = wire['payload'];
    return SnapshotPageMessage(
      snapshotId: _string(wire, 'snapshotId'),
      sessionId: _string(wire, 'sessionId'),
      lastSeq: wire['lastSeq'] is int ? wire['lastSeq'] as int : 0,
      pageIndex: wire['pageIndex'] is int ? wire['pageIndex'] as int : 0,
      pageCount: wire['pageCount'] is int ? wire['pageCount'] as int : 0,
      byteLength: wire['byteLength'] is int ? wire['byteLength'] as int : 0,
      sha256: _string(wire, 'sha256'),
      payload: page is Map ? _wire(page) : const <String, Object?>{},
    );
  }

  final String snapshotId;
  final String sessionId;
  final int lastSeq;
  final int pageIndex;
  final int pageCount;
  final int byteLength;
  final String sha256;
  final Map<String, Object?> payload;

  /// 页内事件；仅 recentEvents，不含新 seq。
  List<TimelineEvent> get events {
    final raw = payload['recentEvents'];
    return raw is List
        ? raw
            .whereType<Map<dynamic, dynamic>>()
            .map((event) => _event(event))
            .toList(growable: false)
        : const <TimelineEvent>[];
  }
}

TimelineEvent _event(Map<dynamic, dynamic> raw) {
  final wire = _wire(raw);
  return TimelineEvent(
    messageId: wire['messageId'] is String ? wire['messageId'] as String : '',
    timestamp: wire['timestamp'] is int ? wire['timestamp'] as int : 0,
    type: wire['type'] is String ? wire['type'] as String : '',
    payload: wire['payload'] is Map ? _wire(wire['payload']) : const {},
    eventId: wire['eventId'] is String ? wire['eventId'] as String : '',
    sessionId: wire['sessionId'] is String ? wire['sessionId'] as String : '',
    seq: wire['seq'] is int ? wire['seq'] as int : 0,
    runId: wire['runId'] is String ? wire['runId'] as String : null,
    approvalId: wire['approvalId'] is String ? wire['approvalId'] as String : null,
  );
}

Map<String, Object?> _wire(Object? value) {
  if (value is! Map) return const <String, Object?>{};
  return value.map((key, item) => MapEntry('$key', item));
}

int _int(JsonMap wire, String key) {
  final value = wire[key];
  if (value is! int) throw const FormatException('invalid S04 message');
  return value;
}

bool _bool(JsonMap wire, String key) {
  final value = wire[key];
  if (value is! bool) throw const FormatException('invalid S04 message');
  return value;
}

String _string(JsonMap wire, String key) {
  final value = wire[key];
  if (value is! String || value.isEmpty) {
    throw const FormatException('invalid S04 message');
  }
  return value;
}