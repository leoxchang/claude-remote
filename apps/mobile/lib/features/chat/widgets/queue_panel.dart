import 'package:flutter/material.dart';

import '../../../domain/session.dart';

/// 当前会话的排队面板；只提供逐项移除，没有清空或排序。
class QueuePanel extends StatelessWidget {
  const QueuePanel({
    super.key,
    required this.queue,
    required this.previews,
    required this.onRemove,
  });

  final List<QueuedRunSummary> queue;

  /// runId → 本地仍持有的草稿预览；未知正文不回传。
  final Map<String, String> previews;
  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    if (queue.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: Text('队列'),
        ),
        for (final run in queue)
          ListTile(
            dense: true,
            title: Text(previews[run.runId] ?? '排队任务'),
            subtitle: Text(
              'run ${shortRunId(run.runId)} · ${formatEnqueuedAt(run.enqueuedAt)}',
            ),
            trailing: IconButton(
              tooltip: '移除',
              icon: const Icon(Icons.close),
              onPressed: () => onRemove(run.runId),
            ),
          ),
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 12),
          child: Text('停止当前不会清除队列'),
        ),
      ],
    );
  }
}

/// 未知正文时只展示短 runId，不虚构标题。
String shortRunId(String runId) =>
    runId.length <= 10 ? runId : runId.substring(0, 10);

/// 入队时间只显示本机时分。
String formatEnqueuedAt(int milliseconds) {
  final time = DateTime.fromMillisecondsSinceEpoch(milliseconds);
  final hour = time.hour.toString().padLeft(2, '0');
  final minute = time.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}