import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../sessions/session_page.dart';
import '../../domain/workspace.dart';
import 'workspace_controller.dart';

/// 项目列表页；App 只能查看本机已授权的项目名称。
class WorkspacePage extends ConsumerStatefulWidget {
  const WorkspacePage({super.key});

  static const String routeName = '/workspaces';

  @override
  ConsumerState<WorkspacePage> createState() => _WorkspacePageState();
}

class _WorkspacePageState extends ConsumerState<WorkspacePage> {
  @override
  void initState() {
    super.initState();
    unawaited(ref.read(workspaceControllerProvider.notifier).refresh());
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(workspaceControllerProvider);
    final scheduler = state.scheduler;
    return Scaffold(
      appBar: AppBar(
        title: const Text('项目'),
        actions: [
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh),
            onPressed: () =>
                ref.read(workspaceControllerProvider.notifier).refresh(),
          ),
        ],
      ),
      body: _body(state, scheduler),
    );
  }

  Widget _body(WorkspaceViewState state, SchedulerSummary? scheduler) {
    if (state.error != null) {
      return Center(
        child: Text(WorkspaceController.messageFor(state.error!)),
      );
    }
    if (state.loading && state.workspaces.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state.workspaces.isEmpty) {
      return const Center(child: Text('还没有授权项目'));
    }
    return ListView(
      children: [
        for (final workspace in state.workspaces)
          ListTile(
            title: Text(workspace.displayName),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => SessionPage(
                  workspaceId: workspace.workspaceId,
                  workspaceName: workspace.displayName,
                ),
              ),
            ),
          ),
        if (scheduler != null) ...[
          const Divider(),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              '全局执行槽 ${scheduler.activeRunCount}/${scheduler.maxActiveRuns}',
            ),
          ),
        ],
      ],
    );
  }
}