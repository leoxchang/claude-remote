/// 每次 Agent 进程启动生成；desktopId 保持长期稳定。
typedef AgentInstanceId = String;

/// App 可见的项目摘要；不含真实路径。
final class WorkspaceSummary {
  const WorkspaceSummary({
    required this.workspaceId,
    required this.displayName,
  });

  factory WorkspaceSummary.fromWire(Map<String, Object?> wire) {
    final workspaceId = wire['workspaceId'];
    final displayName = wire['displayName'];
    return WorkspaceSummary(
      workspaceId: workspaceId is String ? workspaceId : '',
      displayName: displayName is String ? displayName : '',
    );
  }

  final String workspaceId;
  final String displayName;
}

/// 全局调度摘要；globalCapacity 来自快照，scheduler 来自 workspace.list。
final class SchedulerSummary {
  const SchedulerSummary({
    required this.maxActiveRuns,
    required this.activeRunCount,
    required this.queuedRunCount,
    required this.maxQueuedRuns,
    this.pendingApprovalCount = 0,
  });

  factory SchedulerSummary.fromWire(Map<String, Object?> wire) {
    final maxActiveRuns = wire['maxActiveRuns'];
    final activeRunCount = wire['activeRunCount'];
    final queuedRunCount = wire['queuedRunCount'];
    final maxQueuedRuns = wire['maxQueuedRuns'];
    return SchedulerSummary(
      maxActiveRuns: maxActiveRuns is int ? maxActiveRuns : 2,
      activeRunCount: activeRunCount is int ? activeRunCount : 0,
      queuedRunCount: queuedRunCount is int ? queuedRunCount : 0,
      maxQueuedRuns: maxQueuedRuns is int ? maxQueuedRuns : 100,
      pendingApprovalCount: wire['pendingApprovalCount'] is int
          ? wire['pendingApprovalCount'] as int
          : 0,
    );
  }

  final int maxActiveRuns;
  final int activeRunCount;
  final int queuedRunCount;
  final int maxQueuedRuns;
}

/// `workspace.list` 的结果。
final class WorkspaceList {
  const WorkspaceList({required this.workspaces, required this.scheduler});

  factory WorkspaceList.fromWire(Map<String, Object?> wire) {
    final rawWorkspaces = wire['workspaces'];
    final rawScheduler = wire['scheduler'];
    return WorkspaceList(
      workspaces: rawWorkspaces is List
          ? rawWorkspaces
              .whereType<Map<dynamic, dynamic>>()
              .map((entry) => WorkspaceSummary.fromWire(entry.cast<String, Object?>()))
              .where((workspace) => workspace.workspaceId.isNotEmpty)
              .toList(growable: false)
          : const <WorkspaceSummary>[],
      scheduler: rawScheduler is Map
          ? SchedulerSummary.fromWire(rawScheduler.cast<String, Object?>())
          : const SchedulerSummary(
              maxActiveRuns: 2,
              activeRunCount: 0,
              queuedRunCount: 0,
              maxQueuedRuns: 100,
            ),
    );
  }

  final List<WorkspaceSummary> workspaces;
  final SchedulerSummary scheduler;
}