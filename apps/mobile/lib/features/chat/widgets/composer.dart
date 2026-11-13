import 'package:flutter/material.dart';

/// 输入区：空白或超限时按钮不可用；忙碌时按钮显示“排队”。
class Composer extends StatelessWidget {
  const Composer({
    super.key,
    required this.controller,
    required this.enabled,
    required this.onChanged,
    required this.onSend,
    this.label = '发送',
    this.readOnly = false,
  });

  final TextEditingController controller;
  final bool enabled;
  final ValueChanged<String> onChanged;
  final VoidCallback onSend;
  final String label;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: controller,
                onChanged: onChanged,
                readOnly: readOnly,
                minLines: 1,
                maxLines: 5,
                decoration: const InputDecoration(
                  hintText: '输入消息',
                  border: OutlineInputBorder(),
                ),
              ),
            ),
            const SizedBox(width: 8),
            FilledButton.icon(
              onPressed: enabled ? onSend : null,
              icon: const Icon(Icons.send),
              label: Text(label),
            ),
          ],
        ),
      ),
    );
  }
}