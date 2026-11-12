import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../connection/command_client.dart';
import '../../data/providers.dart';
import '../../domain/workspace.dart';
import '../../protocol/s02_messages.dart';

/// 项目列表页状态；只含公开摘要与全局调度信息。
final class WorkspaceViewState {
  const WorkspaceViewState({
    this.workspaces = const <WorkspaceSummary>[],
    this.scheduler,
    this.loading = false,
    this.error,
  });

  final List<WorkspaceSummary> workspaces;
  final SchedulerSummary? scheduler;
  final bool loading;
  final String? error;

  WorkspaceViewState copyWith({
    List<WorkspaceSummary>? workspaces,
    SchedulerSummary? scheduler,
    bool? loading,
    String? error,
    bool clearError = false,
  }) {
    return WorkspaceViewState(
      workspaces: workspaces ?? this.workspaces,
      scheduler: scheduler ?? this.scheduler,
      loading: loading ?? this.loading,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

/// 拉取项目列表；手机端没有添加/管理入口。
class WorkspaceController extends Notifier<WorkspaceViewState> {
  int _sequence = 0;

  @override
  WorkspaceViewState build() => const WorkspaceViewState();

  /// 按模型查询 `workspace.list`；失败只保留安全错误码。
  Future<void> refresh() async {
    final client = await ref.read(commandClientProvider.future);
    if (client == null) {
      state = state.copyWith(loading: false, error: 'NOT_PAIRED');
      return;
    }
    state = state.copyWith(loading: true, clearError: true);
    try {
      final list = await client.execute(
        S02Commands.workspaceList(
          commandId: _nextId('cmd_ws'),
          traceId: _nextId('trace_ws'),
        ),
      );
      state = WorkspaceViewState(
        workspaces: list.workspaces,
        scheduler: list.scheduler,
      );
    } on CommandTimeout {
      state = state.copyWith(loading: false, error: 'TIMEOUT');
    } on CommandFailure catch (failure) {
      state = state.copyWith(loading: false, error: failure.code);
    }
  }

  /// 面向用户的固定文案；不暴露内部细节。
  static String messageFor(String code) {
    switch (code) {
      case 'NOT_PAIRED':
        return '尚未配对';
      case 'TIMEOUT':
        return '网络超时，请重试';
      case 'WORKSPACE_NOT_ALLOWED':
      case 'WORKSPACE_NOT_FOUND':
        return '项目不可用，请在本机重新授权';
      default:
        return '无法加载项目，请重试';
    }
  }

  String _nextId(String prefix) {
    _sequence += 1;
    return '${prefix}_${DateTime.now().microsecondsSinceEpoch}_$_sequence';
  }
}

final workspaceControllerProvider =
    NotifierProvider<WorkspaceController, WorkspaceViewState>(
      WorkspaceController.new,
    );