import 'package:flutter/material.dart';

import '../../../domain/timeline.dart';

/// 模型思考过程；默认折叠，避免打断正文阅读。
class ThinkingBlock extends StatefulWidget {
  const ThinkingBlock({super.key, required this.thinking});

  final TimelineThinking thinking;

  @override
  State<ThinkingBlock> createState() => _ThinkingBlockState();
}

class _ThinkingBlockState extends State<ThinkingBlock> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final thinking = widget.thinking;
    final status = thinking.completed ? '已完成' : '思考中…';
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(8),
        border: Border(
          left: BorderSide(color: colors.outlineVariant, width: 3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            key: const Key('thinkingToggle'),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  Icon(
                    Icons.psychology_outlined,
                    size: 16,
                    color: colors.outline,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '思考过程 · $status',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 18,
                    color: colors.outline,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    thinking.text,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                      height: 1.45,
                    ),
                  ),
                  if (thinking.contentTruncated)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        '思考内容过长，已截断',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colors.outline,
                        ),
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}