import 'package:flutter/material.dart';

/// 输入区：空白或超限时发送按钮不可用。
class Composer extends StatelessWidget {
  const Composer({
    super.key,
    required this.controller,
    required this.enabled,
    required this.onChanged,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool enabled;
  final ValueChanged<String> onChanged;
  final VoidCallback onSend;

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
                minLines: 1,
                maxLines: 5,
                decoration: const InputDecoration(
                  hintText: '输入消息',
                  border: OutlineInputBorder(),
                ),
              ),
            ),
            const SizedBox(width: 8),
            IconButton.filled(
              onPressed: enabled ? onSend : null,
              icon: const Icon(Icons.send),
              tooltip: '发送',
            ),
          ],
        ),
      ),
    );
  }
}