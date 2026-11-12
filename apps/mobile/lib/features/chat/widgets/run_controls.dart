import 'package:flutter/material.dart';

/// 活跃 run 的停止控制；cancelling 期间禁用。
class RunControls extends StatelessWidget {
  const RunControls({
    super.key,
    required this.busy,
    required this.cancelling,
    required this.onStop,
  });

  final bool busy;
  final bool cancelling;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    if (!busy) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          FilledButton.tonal(
            onPressed: cancelling ? null : onStop,
            child: Text(cancelling ? '正在取消…' : '停止'),
          ),
          const SizedBox(height: 2),
          const Text('停止当前不会清除队列'),
        ],
      ),
    );
  }
}