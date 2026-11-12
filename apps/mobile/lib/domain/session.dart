import '../protocol/decoder.dart';
import '../protocol/messages.dart';
import 'run.dart';

/// 服务端快照；语义见 S01 spec §12.1。
final class SessionSnapshot {
  const SessionSnapshot({
    required this.sessionId,
    required this.events,
    required this.lastSeq,
    this.oldestIncludedSeq,
    this.snapshotTruncated = false,
    this.activeRunId,
    this.activeRunStatus,
    this.lastRunStatus,
    this.sessionStatus,
    this.claudeSessionId,
  });

  /// 从 `session.snapshot` 的 payload 构造；缺失字段按不可用处理。
  factory SessionSnapshot.fromPayload(Map<String, Object?> payload) {
    final session = _objectOrEmpty(payload['session']);
    final activeRun = _objectOrEmpty(payload['activeRun']);
    final recentEvents = payload['recentEvents'];
    final events = recentEvents is List
        ? recentEvents.map(ProtocolDecoder.decodeEvent).toList(growable: false)
        : const <TimelineEvent>[];
    return SessionSnapshot(
      sessionId: _stringOrNull(session['sessionId']),
      events: events,
      lastSeq: _intOrZero(payload['lastSeq']),
      oldestIncludedSeq: _intOrNull(payload['oldestIncludedSeq']),
      snapshotTruncated: payload['snapshotTruncated'] == true,
      activeRunId: _stringOrNull(activeRun['runId']),
      activeRunStatus: RunStatus.tryParse(_stringOrNull(activeRun['status'])),
      lastRunStatus: RunStatus.tryParse(_stringOrNull(payload['lastRunStatus'])),
      sessionStatus: _stringOrNull(session['status']),
      claudeSessionId: _stringOrNull(session['claudeSessionId']),
    );
  }

  final String? sessionId;
  final List<TimelineEvent> events;
  final int lastSeq;
  final int? oldestIncludedSeq;
  final bool snapshotTruncated;
  final String? activeRunId;
  final RunStatus? activeRunStatus;
  final RunStatus? lastRunStatus;
  final String? sessionStatus;
  final String? claudeSessionId;
}

Map<String, Object?> _objectOrEmpty(Object? value) =>
    value is Map ? value.cast<String, Object?>() : const <String, Object?>{};

String? _stringOrNull(Object? value) => value is String ? value : null;

int _intOrZero(Object? value) => value is int ? value : 0;

int? _intOrNull(Object? value) => value is int ? value : null;