import '../protocol/decoder.dart';
import '../protocol/messages.dart';
import '../protocol/s03_messages.dart';
import 'run.dart';

/// 服务端快照；语义见 S01 spec §12.1 与 S02 spec §9.3。
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
    this.title,
    this.model,
    this.hasModel = false,
    this.workspaceId,
    this.queuedRuns = const <QueuedRunSummary>[],
    this.pendingApprovals = const <ApprovalSummary>[],
    this.hasPendingApprovals = false,
    this.pendingApprovalCount = 0,
    this.globalCapacity,
  });

  /// 从 `session.snapshot` 的 payload 构造；缺失字段按不可用处理。
  factory SessionSnapshot.fromPayload(Map<String, Object?> payload) {
    final session = _objectOrEmpty(payload['session']);
    final activeRun = _objectOrEmpty(payload['activeRun']);
    final recentEvents = payload['recentEvents'];
    final events = recentEvents is List
        ? recentEvents.map(ProtocolDecoder.decodeEvent).toList(growable: false)
        : const <TimelineEvent>[];
    final queued = payload['queuedRuns'];
    final sessionId = _stringOrNull(session['sessionId']);
    final workspaceId = _stringOrEmpty(session['workspaceId']);
    final activeRunId = _stringOrNull(activeRun['runId']);
    final pendingWire = payload['pendingApprovals'];
    final pendingApprovals = pendingWire is List
        ? pendingWire
            .map(
              (entry) => ApprovalSummary.fromSnapshotEntry(
                entry,
                sessionId: sessionId ?? '',
                workspaceId: workspaceId,
                runId: activeRunId ?? '',
              ),
            )
            .whereType<ApprovalSummary>()
            .toList(growable: false)
        : const <ApprovalSummary>[];
    return SessionSnapshot(
      sessionId: sessionId,
      events: events,
      lastSeq: _intOrZero(payload['lastSeq']),
      oldestIncludedSeq: _intOrNull(payload['oldestIncludedSeq']),
      snapshotTruncated: payload['snapshotTruncated'] == true,
      activeRunId: activeRunId,
      activeRunStatus: RunStatus.tryParse(_stringOrNull(activeRun['status'])),
      lastRunStatus: RunStatus.tryParse(_stringOrNull(payload['lastRunStatus'])),
      sessionStatus: _stringOrNull(session['status']),
      claudeSessionId: _stringOrNull(session['claudeSessionId']),
      title: _stringOrNull(session['title']),
      model: _stringOrNull(session['model']),
      hasModel: session.containsKey('model'),
      workspaceId: _stringOrNull(session['workspaceId']),
      queuedRuns: queued is List
          ? queued
              .whereType<Map<dynamic, dynamic>>()
              .map(QueuedRunSummary.fromWire)
              .whereType<QueuedRunSummary>()
              .toList(growable: false)
          : const <QueuedRunSummary>[],
      pendingApprovals: pendingApprovals,
      hasPendingApprovals: payload.containsKey('pendingApprovals'),
      pendingApprovalCount: _intOrZero(activeRun['pendingApprovalCount']),
      globalCapacity: payload['globalCapacity'] is Map
          ? GlobalCapacity.fromWire(
              (payload['globalCapacity'] as Map).cast<String, Object?>(),
            )
          : null,
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
  final String? title;
  final String? model;

  /// session 对象是否携带 model 字段；缺失时 reducer 保留本地值。
  final bool hasModel;

  /// 会话所属 workspace；缺失时 App 保留本地值。
  final String? workspaceId;
  final List<QueuedRunSummary> queuedRuns;
  final List<ApprovalSummary> pendingApprovals;
  final bool hasPendingApprovals;
  final int pendingApprovalCount;
  final GlobalCapacity? globalCapacity;
}

/// 会话列表摘要；不包含 prompt、事件正文或 rootPath。
final class SessionSummary {
  const SessionSummary({
    required this.sessionId,
    required this.workspaceId,
    required this.title,
    required this.createdAt,
    required this.lastActivityAt,
    this.claudeSessionId,
    this.status = 'idle',
    this.activeRunId,
    this.queuedCount = 0,
    this.pendingApprovalCount = 0,
    this.model,
  });

  factory SessionSummary.fromWire(Map<String, Object?> wire) {
    return SessionSummary(
      sessionId: _stringOrEmpty(wire['sessionId']),
      workspaceId: _stringOrEmpty(wire['workspaceId']),
      title: _stringOrEmpty(wire['title']),
      createdAt: _intOrZero(wire['createdAt']),
      lastActivityAt: _intOrZero(wire['lastActivityAt']),
      claudeSessionId: _stringOrNull(wire['claudeSessionId']),
      status: _stringOrNull(wire['status']) ?? 'idle',
      activeRunId: _stringOrNull(wire['activeRunId']),
      queuedCount: _intOrZero(wire['queuedCount']),
      pendingApprovalCount: _intOrZero(wire['pendingApprovalCount']),
      model: _stringOrNull(wire['model']),
    );
  }

  final String sessionId;
  final String workspaceId;
  final String title;
  final int createdAt;
  final int lastActivityAt;
  final String? claudeSessionId;
  final String status;
  final String? activeRunId;
  final int queuedCount;
  final int pendingApprovalCount;

  /// 当前生效的模型；null 表示跟随 Mac 端默认模型。
  final String? model;

  bool get isArchived => status == 'archived';

  SessionSummary copyWith({
    String? title,
    String? status,
    String? activeRunId,
    int? queuedCount,
    int? pendingApprovalCount,
    int? lastActivityAt,
    String? claudeSessionId,
    String? model,
    bool clearModel = false,
  }) {
    return SessionSummary(
      sessionId: sessionId,
      workspaceId: workspaceId,
      title: title ?? this.title,
      createdAt: createdAt,
      lastActivityAt: lastActivityAt ?? this.lastActivityAt,
      claudeSessionId: claudeSessionId ?? this.claudeSessionId,
      status: status ?? this.status,
      activeRunId: activeRunId ?? this.activeRunId,
      queuedCount: queuedCount ?? this.queuedCount,
      pendingApprovalCount:
          pendingApprovalCount ?? this.pendingApprovalCount,
      model: clearModel ? null : (model ?? this.model),
    );
  }
}

/// 排队中的 run 摘要；不含 prompt 正文。
final class QueuedRunSummary {
  const QueuedRunSummary({
    required this.runId,
    required this.commandId,
    required this.enqueuedAt,
    this.status = 'queued',
  });

  /// 缺失必填字段时返回 null。
  static QueuedRunSummary? fromWire(Map<dynamic, dynamic> wire) {
    final runId = wire['runId'];
    final commandId = wire['commandId'];
    final enqueuedAt = wire['enqueuedAt'];
    if (runId is! String || runId.isEmpty) return null;
    if (commandId is! String || commandId.isEmpty) return null;
    if (enqueuedAt is! int) return null;
    return QueuedRunSummary(
      runId: runId,
      commandId: commandId,
      enqueuedAt: enqueuedAt,
      status: wire['status'] is String ? wire['status'] as String : 'queued',
    );
  }

  final String runId;
  final String commandId;
  final int enqueuedAt;
  final String status;
}

/// 全局执行槽状态。
final class GlobalCapacity {
  const GlobalCapacity({required this.activeRunCount, required this.maxActiveRuns});

  factory GlobalCapacity.fromWire(Map<String, Object?> wire) {
    return GlobalCapacity(
      activeRunCount: _intOrZero(wire['activeRunCount']),
      maxActiveRuns: _intOrZero(wire['maxActiveRuns']),
    );
  }

  final int activeRunCount;
  final int maxActiveRuns;

  bool get isFull => activeRunCount >= maxActiveRuns;
}

Map<String, Object?> _objectOrEmpty(Object? value) =>
    value is Map ? value.cast<String, Object?>() : const <String, Object?>{};

String? _stringOrNull(Object? value) => value is String ? value : null;

String _stringOrEmpty(Object? value) =>
    value is String ? value : '';

int _intOrZero(Object? value) => value is int ? value : 0;

int? _intOrNull(Object? value) => value is int ? value : null;