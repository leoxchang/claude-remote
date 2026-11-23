import 'package:flutter/material.dart';

import '../../../domain/timeline.dart';

/// 工具输出预览的截断结果；超过上限时追加显式标记。
String toolPreview(String output, {int maxChars = 256 * 1024}) {
  if (output.length <= maxChars) return output;
  return '${output.substring(0, maxChars)}\n…（已截断）';
}

/// 从工具入参里提取一行可读摘要；未知工具回退到首个标量字段。
String toolInputSummary(TimelineTool tool) {
  final input = tool.input;
  final summary = switch (tool.toolName) {
    'Bash' => _string(input['command']),
    'Read' || 'Write' || 'Edit' || 'NotebookEdit' => _string(input['file_path']),
    'Grep' => _join([_string(input['pattern']), _string(input['path'])]),
    'Glob' => _string(input['pattern']),
    'WebFetch' => _string(input['url']),
    'WebSearch' => _string(input['query']),
    'Task' => _string(input['description']),
    _ => _firstScalar(input),
  };
  if (summary == null || summary.isEmpty) return '';
  final single = summary.replaceAll(RegExp(r'\s+'), ' ').trim();
  return single.length <= 200 ? single : '${single.substring(0, 200)}…';
}

String? _string(Object? value) => value is String ? value : null;

String? _join(List<String?> parts) {
  final present = parts.whereType<String>().where((p) => p.isNotEmpty).toList();
  return present.isEmpty ? null : present.join(' · ');
}

String? _firstScalar(Map<String, Object?> input) {
  for (final entry in input.entries) {
    final value = entry.value;
    if (value is String || value is num || value is bool) {
      return '$value';
    }
  }
  return null;
}

/// 单个工具卡片：展示调用参数、执行状态与可展开的输出。
class ToolCard extends StatefulWidget {
  const ToolCard({super.key, required this.tool});

  final TimelineTool tool;

  @override
  State<ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<ToolCard> {
  static const int _collapsedLines = 8;

  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final tool = widget.tool;
    final status = tool.status ?? 'running';
    final theme = Theme.of(context);
    final inputSummary = toolInputSummary(tool);
    final output = toolPreview(tool.output);
    final lines = output.split('\n');
    final collapsed = !_expanded && lines.length > _collapsedLines;
    final visible = collapsed
        ? '${lines.take(_collapsedLines).join('\n')}\n…'
        : output;
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
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                Text(
                  _statusLabel(status),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: _statusColor(theme.colorScheme, status),
                  ),
                ),
              ],
            ),
            if (inputSummary.isNotEmpty)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.only(top: 6),
                padding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerHighest.withValues(
                    alpha: 0.6,
                  ),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  inputSummary,
                  maxLines: _expanded ? 6 : 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontFamily: 'Menlo',
                  ),
                ),
              ),
            if (output.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  visible,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontFamily: 'Menlo',
                    height: 1.35,
                  ),
                ),
              ),
            if (tool.outputTruncated)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  '输出过长，已截断',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                ),
              ),
            if (lines.length > _collapsedLines)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  key: const Key('toolToggleOutput'),
                  onPressed: () => setState(() => _expanded = !_expanded),
                  child: Text(_expanded ? '收起' : '展开全部'),
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

  Color _statusColor(ColorScheme colors, String status) {
    return switch (status) {
      'denied' || 'failed' => colors.error,
      'succeeded' => colors.primary,
      _ => colors.outline,
    };
  }
}