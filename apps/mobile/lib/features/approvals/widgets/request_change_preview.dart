import 'package:flutter/material.dart';

/// 由 Edit/Write 参数生成的行级预览；不是实际文件 Diff。
class RequestChangePreview extends StatelessWidget {
  const RequestChangePreview({
    super.key,
    required this.oldText,
    required this.newText,
  });

  final String oldText;
  final String newText;

  @override
  Widget build(BuildContext context) {
    final removed = oldText.isEmpty ? const <String>[] : oldText.split('\n');
    final added = newText.isEmpty ? const <String>[] : newText.split('\n');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '由请求参数生成，不是实际文件 Diff 或执行结果',
          key: const Key('requestPreviewNotice'),
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 8),
        for (final line in removed)
          SelectableText(
            '- $line',
            style: const TextStyle(fontFamily: 'monospace', color: Colors.red),
          ),
        for (final line in added)
          SelectableText(
            '+ $line',
            style: const TextStyle(fontFamily: 'monospace', color: Colors.green),
          ),
      ],
    );
  }
}