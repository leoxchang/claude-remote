import 'package:flutter/material.dart';

import 'request_change_preview.dart';

/// Write/Edit/NotebookEdit 的完整参数与行级预览。
class FileChangeApprovalView extends StatelessWidget {
  const FileChangeApprovalView({
    super.key,
    required this.toolName,
    required this.input,
  });

  final String toolName;
  final Map<String, Object?> input;

  @override
  Widget build(BuildContext context) {
    final filePath = _string(input['file_path'] ?? input['notebook_path']);
    final oldText = _string(input['old_string']);
    final newText = _string(input['new_string'] ?? input['content']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('文件', style: TextStyle(fontWeight: FontWeight.bold)),
        SelectableText(
          filePath,
          key: const Key('fileChangePath'),
          style: const TextStyle(fontFamily: 'monospace'),
        ),
        const SizedBox(height: 12),
        if (toolName == 'Write' || toolName == 'NotebookEdit') ...[
          const Text('将写入的内容', style: TextStyle(fontWeight: FontWeight.bold)),
          for (final line in newText.split('\n'))
            SelectableText(
              line,
              key: const Key('writtenContentLine'),
              style: const TextStyle(fontFamily: 'monospace'),
            ),
        ] else
          RequestChangePreview(oldText: oldText, newText: newText),
      ],
    );
  }

  String _string(Object? value) => value is String ? value : '';
}