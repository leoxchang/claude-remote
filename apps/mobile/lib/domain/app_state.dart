import '../protocol/messages.dart';
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

  return previous.copyWith(
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
}

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
    claudeSessionId: state.claudeSessionId,
  );
}