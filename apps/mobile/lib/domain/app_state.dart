import '../protocol/envelope.dart';
import '../protocol/messages.dart';
import '../protocol/s03_messages.dart';
import 'session.dart';
import 'session_state.dart';
import 'timeline.dart';
import 'workspace.dart';

/// App 的内存总状态；所有字段不可变，更新都返回新实例。
final class AppState {
  const AppState({
    this.workspaces = const <WorkspaceSummary>[],
    this.scheduler,
    this.sessionsById = const <String, SessionSummary>{},
    this.sessionStatesById = const <String, SessionState>{},
    this.timelinesBySessionId = const <String, TimelineState>{},
    this.composerDraftsBySessionId = const <String, String>{},
    this.pendingApprovalsById = const <String, ApprovalSummary>{},
    this.approvalIdsBySessionId = const <String, List<String>>{},
    this.approvalEventFingerprints = const <String, String>{},
    this.selectedSessionId,
    this.agentInstanceId,
  });

  factory AppState.initial() => const AppState();

  final List<WorkspaceSummary> workspaces;
  final SchedulerSummary? scheduler;
  final Map<String, SessionSummary> sessionsById;
  final Map<String, SessionState> sessionStatesById;
  final Map<String, TimelineState> timelinesBySessionId;
  final Map<String, String> composerDraftsBySessionId;
  final Map<String, ApprovalSummary> pendingApprovalsById;
  final Map<String, List<String>> approvalIdsBySessionId;
  final Map<String, String> approvalEventFingerprints;
  final String? selectedSessionId;
  final AgentInstanceId? agentInstanceId;

  SessionSummary? get selectedSession =>
      selectedSessionId == null ? null : sessionsById[selectedSessionId];

  String draftFor(String sessionId) =>
      composerDraftsBySessionId[sessionId] ?? '';

  AppState copyWith({
    List<WorkspaceSummary>? workspaces,
    SchedulerSummary? scheduler,
    Map<String, SessionSummary>? sessionsById,
    Map<String, SessionState>? sessionStatesById,
    Map<String, TimelineState>? timelinesBySessionId,
    Map<String, String>? composerDraftsBySessionId,
    Map<String, ApprovalSummary>? pendingApprovalsById,
    Map<String, List<String>>? approvalIdsBySessionId,
    Map<String, String>? approvalEventFingerprints,
    String? selectedSessionId,
    bool clearSelection = false,
    AgentInstanceId? agentInstanceId,
  }) {
    return AppState(
      workspaces: workspaces ?? this.workspaces,
      scheduler: scheduler ?? this.scheduler,
      sessionsById: sessionsById ?? this.sessionsById,
      sessionStatesById: sessionStatesById ?? this.sessionStatesById,
      timelinesBySessionId:
          timelinesBySessionId ?? this.timelinesBySessionId,
      composerDraftsBySessionId:
          composerDraftsBySessionId ?? this.composerDraftsBySessionId,
      pendingApprovalsById:
          pendingApprovalsById ?? this.pendingApprovalsById,
      approvalIdsBySessionId:
          approvalIdsBySessionId ?? this.approvalIdsBySessionId,
      approvalEventFingerprints:
          approvalEventFingerprints ?? this.approvalEventFingerprints,
      selectedSessionId:
          clearSelection ? null : (selectedSessionId ?? this.selectedSessionId),
      agentInstanceId: agentInstanceId ?? this.agentInstanceId,
    );
  }

  /// 只改变本地导航；不影响命令目标、事件目标或其他草稿。
  AppState selectSession(String? sessionId) {
    return sessionId == null
        ? copyWith(clearSelection: true)
        : copyWith(selectedSessionId: sessionId);
  }

  /// 每个会话独立草稿。
  AppState updateDraft(String sessionId, String text) {
    return copyWith(
      composerDraftsBySessionId: {
        ...composerDraftsBySessionId,
        sessionId: text,
      },
    );
  }
}

/// 应用一条时间线事件；未知会话只保存状态，不改变当前选择。
AppState applyTimelineEvent(AppState previous, TimelineEvent event) {
  final timeline = previous.timelinesBySessionId[event.sessionId] ??
      TimelineState.initial(event.sessionId);
  final nextTimeline = applyEvent(timeline, event);
  final summary = previous.sessionsById[event.sessionId];
  final baseState = previous.sessionStatesById[event.sessionId] ??
      (summary == null
          ? SessionState(
              sessionId: event.sessionId,
              workspaceId: '',
            )
          : SessionState.fromSummary(summary));
  final nextState = applyEventToSession(baseState, event);

  return previous.copyWith(
    timelinesBySessionId: {
      ...previous.timelinesBySessionId,
      event.sessionId: nextTimeline,
    },
    sessionStatesById: {
      ...previous.sessionStatesById,
      event.sessionId: nextState,
    },
    sessionsById: summary == null
        ? previous.sessionsById
        : {
            ...previous.sessionsById,
            event.sessionId: _summaryFromState(summary, nextState),
          },
  );
}

/// 应用目标会话快照；其他会话的时间线、队列与草稿保持原对象。
AppState applySessionSnapshot(AppState previous, SessionSnapshot snapshot) {
  final sessionId = snapshot.sessionId;
  if (sessionId == null) return previous;
  final timeline = applySnapshot(
    previous.timelinesBySessionId[sessionId] ??
        TimelineState.initial(sessionId),
    snapshot,
  );
  final summary = previous.sessionsById[sessionId];
  final baseState = previous.sessionStatesById[sessionId] ??
      (summary == null
          ? SessionState(sessionId: sessionId, workspaceId: '')
          : SessionState.fromSummary(summary));
  final nextState = applySnapshotToSession(baseState, snapshot);

  final next = previous.copyWith(
    timelinesBySessionId: {
      ...previous.timelinesBySessionId,
      sessionId: timeline,
    },
    sessionStatesById: {
      ...previous.sessionStatesById,
      sessionId: nextState,
    },
    sessionsById: summary == null
        ? previous.sessionsById
        : {
            ...previous.sessionsById,
            sessionId: _summaryFromState(summary, nextState),
          },
  );
  return snapshot.hasPendingApprovals
      ? _replaceSessionApprovals(next, sessionId, snapshot.pendingApprovals)
      : next;
}

/// 用快照替换目标 session 的 pending；其他 session 的审批保持原样。
AppState _replaceSessionApprovals(
  AppState previous,
  String sessionId,
  List<ApprovalSummary> pending,
) {
  final byId = <String, ApprovalSummary>{...previous.pendingApprovalsById};
  final previousIds =
      previous.approvalIdsBySessionId[sessionId] ?? const <String>[];
  for (final approvalId in previousIds) {
    byId.remove(approvalId);
  }
  final ids = <String>[];
  for (final summary in pending) {
    if (summary.sessionId != sessionId) {
      throw ProtocolConflictException(
        'snapshot for $sessionId contains approval ${summary.approvalId} '
        'from ${summary.sessionId}',
      );
    }
    final existing = previous.pendingApprovalsById[summary.approvalId];
    if (existing != null && existing.sessionId != sessionId) {
      throw ProtocolConflictException(
        'approval ${summary.approvalId} is bound to ${existing.sessionId}',
      );
    }
    byId[summary.approvalId] = summary;
    ids.add(summary.approvalId);
  }
  return previous.copyWith(
    pendingApprovalsById: byId,
    approvalIdsBySessionId: {
      ...previous.approvalIdsBySessionId,
      sessionId: ids,
    },
  );
}

/// 应用一条审批事件；eventId 去重，冲突与跨 session 串线抛异常。
AppState applyApprovalEvent(AppState previous, TimelineEvent event) {
  if (event.type != 'permission.requested' &&
      event.type != 'permission.resolved') {
    return previous;
  }
  final fingerprint = _approvalFingerprint(event);
  final known = previous.approvalEventFingerprints[event.eventId];
  if (known != null) {
    if (known == fingerprint) return previous;
    throw ProtocolConflictException(
      'approval eventId ${event.eventId} retransmitted with different content',
    );
  }
  final stamped = previous.copyWith(
    approvalEventFingerprints: {
      ...previous.approvalEventFingerprints,
      event.eventId: fingerprint,
    },
  );
  if (event.type == 'permission.requested') {
    final summary = ApprovalSummary.fromEvent(event);
    if (summary == null) {
      throw ProtocolConflictException(
        'permission.requested ${event.eventId} is missing safe fields',
      );
    }
    final existing = stamped.pendingApprovalsById[summary.approvalId];
    if (existing != null && existing.sessionId != summary.sessionId) {
      throw ProtocolConflictException(
        'approval ${summary.approvalId} arrived for two sessions',
      );
    }
    final ids =
        stamped.approvalIdsBySessionId[summary.sessionId] ?? const <String>[];
    return stamped.copyWith(
      pendingApprovalsById: {
        ...stamped.pendingApprovalsById,
        summary.approvalId: summary,
      },
      approvalIdsBySessionId: {
        ...stamped.approvalIdsBySessionId,
        summary.sessionId:
            ids.contains(summary.approvalId) ? ids : [...ids, summary.approvalId],
      },
    );
  }
  final resolution = PermissionResolution.fromEvent(event);
  if (resolution == null) {
    throw ProtocolConflictException(
      'permission.resolved ${event.eventId} is missing safe fields',
    );
  }
  return _removeApproval(stamped, resolution.approvalId);
}

AppState _removeApproval(AppState previous, String approvalId) {
  final summary = previous.pendingApprovalsById[approvalId];
  if (summary == null) return previous;
  final byId = <String, ApprovalSummary>{...previous.pendingApprovalsById}
    ..remove(approvalId);
  final ids = previous.approvalIdsBySessionId[summary.sessionId] ?? const <String>[];
  return previous.copyWith(
    pendingApprovalsById: byId,
    approvalIdsBySessionId: {
      ...previous.approvalIdsBySessionId,
      summary.sessionId: ids
          .where((id) => id != approvalId)
          .toList(growable: false),
    },
  );
}

String _approvalFingerprint(TimelineEvent event) =>
    '${event.sessionId}|${event.approvalId}|${event.type}|${event.payload}';

/// workspace.list 的结果覆盖项目列表与调度摘要。
AppState applyWorkspaceList(AppState previous, WorkspaceList list) {
  return previous.copyWith(
    workspaces: list.workspaces,
    scheduler: list.scheduler,
  );
}

/// 会话列表只合并摘要，不动时间线、队列与草稿。
AppState applySessionPage(AppState previous, List<SessionSummary> sessions) {
  final merged = <String, SessionSummary>{...previous.sessionsById};
  for (final session in sessions) {
    final existingState = previous.sessionStatesById[session.sessionId];
    merged[session.sessionId] = existingState == null
        ? session
        : _summaryFromState(session, existingState);
  }
  return previous.copyWith(sessionsById: merged);
}

/// Agent 新实例：清空对话性状态，保留设备与项目列表。
AppState applyAgentInstance(
  AppState previous,
  AgentInstanceId agentInstanceId,
) {
  if (previous.agentInstanceId == agentInstanceId) return previous;
  return AppState(
    workspaces: previous.workspaces,
    scheduler: previous.scheduler,
    sessionsById: const <String, SessionSummary>{},
    sessionStatesById: const <String, SessionState>{},
    timelinesBySessionId: const <String, TimelineState>{},
    composerDraftsBySessionId: previous.composerDraftsBySessionId,
    selectedSessionId: null,
    agentInstanceId: agentInstanceId,
  );
}

/// 只保留当前会话与仍有活跃/排队 run 的会话时间线。
AppState evictIdleTimelines(AppState previous) {
  final keep = <String>{
    if (previous.selectedSessionId != null) previous.selectedSessionId!,
    for (final entry in previous.sessionStatesById.entries)
      if (entry.value.hasActiveRun || entry.value.queue.isNotEmpty)
        entry.key,
  };
  final next = <String, TimelineState>{};
  for (final entry in previous.timelinesBySessionId.entries) {
    if (keep.contains(entry.key)) next[entry.key] = entry.value;
  }
  return next.length == previous.timelinesBySessionId.length
      ? previous
      : previous.copyWith(timelinesBySessionId: next);
}

SessionSummary _summaryFromState(
  SessionSummary summary,
  SessionState state,
) {
  return summary.copyWith(
    title: state.title.isEmpty ? summary.title : state.title,
    status: state.status,
    activeRunId: state.activeRunId,
    queuedCount: state.queue.length,
    pendingApprovalCount: state.pendingApprovalCount,
    claudeSessionId: state.claudeSessionId,
  );
}