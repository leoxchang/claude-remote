import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../connection/command_client.dart';
import '../../data/providers.dart';
import '../../domain/session.dart';
import '../../protocol/s02_messages.dart';

/// 会话列表页状态；archived 只在显式打开时请求。
final class SessionListState {
  const SessionListState({
    this.workspaceId,
    this.sessions = const <SessionSummary>[],
    this.nextCursor,
    this.includeArchived = false,
    this.loading = false,
    this.error,
  });

  final String? workspaceId;
  final List<SessionSummary> sessions;
  final String? nextCursor;
  final bool includeArchived;
  final bool loading;
  final String? error;

  List<SessionSummary> get activeSessions =>
      sessions.where((session) => !session.isArchived).toList(growable: false);

  List<SessionSummary> get archivedSessions =>
      sessions.where((session) => session.isArchived).toList(growable: false);

  SessionListState copyWith({
    String? workspaceId,
    List<SessionSummary>? sessions,
    String? nextCursor,
    bool clearCursor = false,
    bool? includeArchived,
    bool? loading,
    String? error,
    bool clearError = false,
  }) {
    return SessionListState(
      workspaceId: workspaceId ?? this.workspaceId,
      sessions: sessions ?? this.sessions,
      nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
      includeArchived: includeArchived ?? this.includeArchived,
      loading: loading ?? this.loading,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

/// 会话列表的拉取与本地变更；命令全部走 CommandClient。
class SessionListController extends Notifier<SessionListState> {
  /// 每页固定 20 条，与 Mac 默认值一致。
  static const int pageSize = 20;

  int _sequence = 0;

  @override
  SessionListState build() => const SessionListState();

  Future<void> loadFirstPage(String workspaceId) {
    return _load(workspaceId: workspaceId, replace: true);
  }

  Future<void> loadNextPage() {
    final cursor = state.nextCursor;
    final workspaceId = state.workspaceId;
    if (cursor == null || workspaceId == null) return Future<void>.value();
    return _load(workspaceId: workspaceId, cursor: cursor, replace: false);
  }

  Future<void> setIncludeArchived(bool value) {
    state = state.copyWith(includeArchived: value, clearCursor: true);
    final workspaceId = state.workspaceId;
    if (workspaceId == null) return Future<void>.value();
    return _load(workspaceId: workspaceId, replace: true);
  }

  Future<SessionSummary?> create({String? title}) {
    final workspaceId = state.workspaceId;
    if (workspaceId == null) {
      state = state.copyWith(error: 'WORKSPACE_NOT_FOUND');
      return Future<SessionSummary?>.value();
    }
    return _run(
      (client) => client.execute(
        S02Commands.sessionCreate(
          commandId: _nextId('cmd_create'),
          traceId: _nextId('trace_create'),
          workspaceId: workspaceId,
          title: title,
        ),
      ),
      (summary) => state = state.copyWith(
        sessions: [
          summary,
          ...state.sessions.where(
            (session) => session.sessionId != summary.sessionId,
          ),
        ],
      ),
    );
  }

  Future<SessionSummary?> resume(String sessionId) {
    return _run(
      (client) => client.execute(
        S02Commands.sessionResume(
          commandId: _nextId('cmd_resume'),
          traceId: _nextId('trace_resume'),
          sessionId: sessionId,
        ),
      ),
    );
  }

  Future<void> rename(String sessionId, String title) async {
    await _run(
      (client) => client.execute(
        S02Commands.sessionRename(
          commandId: _nextId('cmd_rename'),
          traceId: _nextId('trace_rename'),
          sessionId: sessionId,
          title: title,
        ),
      ),
      (summary) => state = state.copyWith(
        sessions: _replace(state.sessions, summary),
      ),
    );
  }

  Future<void> archive(String sessionId) async {
    await _run(
      (client) => client.execute(
        S02Commands.sessionArchive(
          commandId: _nextId('cmd_archive'),
          traceId: _nextId('trace_archive'),
          sessionId: sessionId,
        ),
      ),
      (summary) => state = state.copyWith(
        sessions: _replace(state.sessions, summary),
      ),
    );
  }

  /// 面向用户的固定文案；不暴露内部细节。
  static String messageFor(String code) {
    switch (code) {
      case 'INVALID_CURSOR':
        return '列表已过期，请重新加载';
      case 'SESSION_BUSY':
        return '会话仍在运行或排队，暂时不能归档';
      case 'SESSION_ARCHIVED':
        return '会话已归档，只能查看';
      case 'SESSION_SELECTION_REQUIRED':
        return '存在多个会话，请选择其中一个';
      case 'PROMPT_PENDING':
        return '上一条消息尚未确认，请稍后重试';
      case 'NO_PENDING_PROMPT':
        return '没有待重试的任务';
      case 'QUEUE_FULL':
        return '队列已满，稍后再试';
      case 'WORKSPACE_NOT_ALLOWED':
      case 'WORKSPACE_NOT_FOUND':
        return '项目不可用，请在本机重新授权';
      case 'NOT_PAIRED':
        return '尚未配对';
      case 'TIMEOUT':
        return '网络超时，请重试';
      default:
        return '操作失败，请重试';
    }
  }

  Future<void> _load({
    required String workspaceId,
    String? cursor,
    required bool replace,
  }) async {
    final client = await ref.read(commandClientProvider.future);
    if (client == null) {
      state = state.copyWith(loading: false, error: 'NOT_PAIRED');
      return;
    }
    state = state.copyWith(
      workspaceId: workspaceId,
      loading: true,
      clearError: true,
    );
    try {
      final page = await client.execute(
        S02Commands.sessionList(
          commandId: _nextId('cmd_list'),
          traceId: _nextId('trace_list'),
          workspaceId: workspaceId,
          includeArchived: state.includeArchived,
          limit: pageSize,
          cursor: cursor,
        ),
      );
      final merged = replace
          ? page.sessions
          : [
              ...state.sessions,
              ...page.sessions.where(
                (session) => !state.sessions.any(
                  (existing) => existing.sessionId == session.sessionId,
                ),
              ),
            ];
      state = state.copyWith(
        sessions: merged,
        nextCursor: page.nextCursor,
        clearCursor: page.nextCursor == null,
        loading: false,
      );
    } on CommandTimeout {
      state = state.copyWith(loading: false, error: 'TIMEOUT');
    } on CommandFailure catch (failure) {
      state = state.copyWith(loading: false, error: failure.code);
    }
  }

  Future<T?> _run<T>(
    Future<T> Function(CommandClient client) action, [
    void Function(T value)? apply,
  ]) async {
    final client = await ref.read(commandClientProvider.future);
    if (client == null) {
      state = state.copyWith(error: 'NOT_PAIRED');
      return null;
    }
    state = state.copyWith(clearError: true);
    try {
      final value = await action(client);
      apply?.call(value);
      return value;
    } on CommandTimeout {
      state = state.copyWith(error: 'TIMEOUT');
      return null;
    } on CommandFailure catch (failure) {
      state = state.copyWith(error: failure.code);
      return null;
    }
  }

  String _nextId(String prefix) {
    _sequence += 1;
    return '${prefix}_${DateTime.now().microsecondsSinceEpoch}_$_sequence';
  }
}

List<SessionSummary> _replace(
  List<SessionSummary> sessions,
  SessionSummary next,
) {
  final index = sessions.indexWhere(
    (session) => session.sessionId == next.sessionId,
  );
  if (index < 0) return [...sessions, next];
  final copy = [...sessions];
  copy[index] = next;
  return copy;
}

final sessionListControllerProvider =
    NotifierProvider<SessionListController, SessionListState>(
      SessionListController.new,
    );