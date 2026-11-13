import 'package:flutter/material.dart';

/// Bash 完整参数：命令、描述与超时。
class BashApprovalView extends StatelessWidget {
  const BashApprovalView({super.key, required this.input});

  final Map<String, Object?> input;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('命令', style: TextStyle(fontWeight: FontWeight.bold)),
        SelectableText(
          _string(input['command']),
          key: const Key('bashCommand'),
          style: const TextStyle(fontFamily: 'monospace'),
        ),
        if (input['description'] != null) ...[
          const SizedBox(height: 8),
          const Text('描述', style: TextStyle(fontWeight: FontWeight.bold)),
          SelectableText(_string(input['description'])),
        ],
        if (input['timeout'] != null) ...[
          const SizedBox(height: 8),
          Text('超时：${_string(input['timeout'])}'),
        ],
      ],
    );
  }

  String _string(Object? value) => value is String ? value : '$value';
}