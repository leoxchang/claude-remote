import 'package:flutter/material.dart';

/// 退后台时的审批遮罩；不渲染任何正文。
class ApprovalPrivacyMask extends StatelessWidget {
  const ApprovalPrivacyMask({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('approvalPrivacyMask'),
      color: Theme.of(context).colorScheme.surface,
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.lock_outline, size: 40),
          const SizedBox(height: 12),
          Text('审批内容已隐藏', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          const Text('回到前台后重新加载'),
        ],
      ),
    );
  }
}