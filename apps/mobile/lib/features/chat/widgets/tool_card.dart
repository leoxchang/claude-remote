import 'package:flutter/material.dart';

import '../../../domain/timeline.dart';

/// 工具输出预览的截断结果；超过上限时追加显式标记。
String toolPreview(String output, {int maxChars = 256 * 1024}) {
  if (output.length <= maxChars) return output;
  return '${output.substring(0, maxChars)}\n…（已截断）';
}

/// 单个工具卡片；按 toolUseId 更新，权限拒绝时显示固定文案。
class ToolCard extends StatelessWidget {
  const ToolCard({super.key, required this.tool});

  final TimelineTool tool;

  @override
  Widget build(BuildContext context) {
    final status = tool.status ?? 'running';
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    tool.toolName.isEmpty ? '工具' : tool.toolName,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                Text(_statusLabel(status)),
              ],
            ),
            if (tool.output.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  toolPreview(tool.output),
                  maxLines: 20,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
        ),
      ),
    );
  }

  String _statusLabel(String status) {
    return switch (status) {
      'denied' => '已拒绝',
      'failed' => '失败',
      'cancelled' => '已取消',
      'succeeded' => '完成',
      _ => '执行中',
    };
  }
}