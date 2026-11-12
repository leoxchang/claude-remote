import '../protocol/messages.dart';
import 'run.dart';
import 'session.dart';

/// 单个会话的易失状态：状态、Claude 映射、activeRun 与队列。
final class SessionState {
  const SessionState({
    required this.sessionId,
    required this.workspaceId,
    this.title = '',
    this.status = 'idle',
    this.claudeSessionId,
    this.activeRunId,
    this.activeRunStatus,
    this.lastRunStatus,
    this.queue = const <QueuedRunSummary>[],
    this.globalCapacity = const GlobalCapacity(
      activeRunCount: 0,
      maxActiveRuns: 2,
    ),
  });

  factory SessionState.fromSummary(SessionSummary summary) {
    return SessionState(
      sessionId: summary.sessionId,
      workspaceId: summary.workspaceId,
      title: summary.title,
      status: summary.status,
      claudeSessionId: summary.claudeSessionId,
      activeRunId: summary.activeRunId,
    );
  }

  final String sessionId;
  final String workspaceId;
  final String title;
  final String status;
  final String? claudeSessionId;
  final String? activeRunId;
  final RunStatus? activeRunStatus;
  final RunStatus? lastRunStatus;
  final List<QueuedRunSummary> queue;
  final GlobalCapacity globalCapacity;

  bool get isArchived => status == 'archived';
  bool get hasActiveRun => activeRunId != null;

  SessionState copyWith({
    String? title,
    String? status,
    String? claudeSessionId,
    String? activeRunId,
    bool clearActiveRun = false,
    RunStatus? activeRunStatus,
    RunStatus? lastRunStatus,
    List<QueuedRunSummary>? queue,
    GlobalCapacity? globalCapacity,
  }) {
    return SessionState(
      sessionId: sessionId,
      workspaceId: workspaceId,
      title: title ?? this.title,
      status: status ?? this.status,
      claudeSessionId: claudeSessionId ?? this.claudeSessionId,
      activeRunId: clearActiveRun ? null : (activeRunId ?? this.activeRunId),
      activeRunStatus: clearActiveRun
          ? null
          : (activeRunStatus ?? this.activeRunStatus),
      lastRunStatus: lastRunStatus ?? this.lastRunStatus,
      queue: queue ?? this.queue,
      globalCapacity: globalCapacity ?? this.globalCapacity,
    );
  }
}

/// 快照只替换目标会话的易失状态；保留未知字段的本地值。
SessionState applySnapshotToSession(
  SessionState previous,
  SessionSnapshot snapshot,
) {
  return SessionState(
    sessionId: previous.sessionId,
    workspaceId: previous.workspaceId,
    title: snapshot.title ?? previous.title,
    status: snapshot.sessionStatus ?? previous.status,
    claudeSessionId: snapshot.claudeSessionId ?? previous.claudeSessionId,
    activeRunId: snapshot.activeRunId,
    activeRunStatus: snapshot.activeRunStatus,
    lastRunStatus: snapshot.lastRunStatus ?? previous.lastRunStatus,
    queue: snapshot.queuedRuns,
    globalCapacity: snapshot.globalCapacity ?? previous.globalCapacity,
  );
}

/// 应用一条会话事件；只影响该事件所属会话。
SessionState applyEventToSession(SessionState previous, TimelineEvent event) {
  switch (event.type) {
    case 'run.queued':
      final runId = event.runId;
      if (runId == null) return previous;
      if (previous.queue.any((run) => run.runId == runId)) return previous;
      final enqueuedAt = event.payload['enqueuedAt'];
      final commandId = event.payload['commandId'];
      return previous.copyWith(
        queue: [
          ...previous.queue,
          QueuedRunSummary(
            runId: runId,
            commandId: commandId is String ? commandId : '',
            enqueuedAt: enqueuedAt is int ? enqueuedAt : 0,
          ),
        ],
        status: previous.isArchived ? 'archived' : 'queued',
      );
    case 'run.started':
      final runId = event.runId;
      if (runId == null) return previous;
      return previous.copyWith(
        queue: previous.queue
            .where((run) => run.runId != runId)
            .toList(growable: false),
        activeRunId: runId,
        activeRunStatus: RunStatus.starting,
        status: previous.isArchived ? 'archived' : 'running',
      );
    case 'run.completed':
      final runId = event.runId;
      final queue = runId == null
          ? previous.queue
          : previous.queue
              .where((run) => run.runId != runId)
              .toList(growable: false);
      final clearsActive = runId != null && previous.activeRunId == runId;
      final nextStatus = previous.isArchived
          ? 'archived'
          : (queue.isEmpty ? 'idle' : 'queued');
      return SessionState(
        sessionId: previous.sessionId,
        workspaceId: previous.workspaceId,
        title: previous.title,
        status: nextStatus,
        claudeSessionId: previous.claudeSessionId,
        activeRunId: clearsActive ? null : previous.activeRunId,
        activeRunStatus: clearsActive ? null : previous.activeRunStatus,
        lastRunStatus:
            RunStatus.tryParse(_stringOrNull(event.payload['status'])) ??
                previous.lastRunStatus,
        queue: queue,
        globalCapacity: previous.globalCapacity,
      );
    case 'session.status':
      final activeRunId = event.payload.containsKey('activeRunId')
          ? _stringOrNull(event.payload['activeRunId'])
          : previous.activeRunId;
      final status =
          _stringOrNull(event.payload['status']) ??
          _stringOrNull(event.payload['state']) ??
          (activeRunId == null ? previous.status : 'running');
      return SessionState(
        sessionId: previous.sessionId,
        workspaceId: previous.workspaceId,
        title: previous.title,
        status: previous.isArchived ? 'archived' : status,
        claudeSessionId:
            _stringOrNull(event.payload['claudeSessionId']) ??
                previous.claudeSessionId,
        activeRunId: activeRunId,
        activeRunStatus: activeRunId == null
            ? null
            : (previous.activeRunStatus ?? RunStatus.starting),
        lastRunStatus: previous.lastRunStatus,
        queue: previous.queue,
        globalCapacity: previous.globalCapacity,
      );
    default:
      return previous;
  }
}

String? _stringOrNull(Object? value) => value is String ? value : null;