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
      child: Align(
        alignment: Alignment.centerRight,
        child: FilledButton.tonal(
          onPressed: cancelling ? null : onStop,
          child: Text(cancelling ? '正在取消…' : '停止'),
        ),
      ),
    );
  }
}