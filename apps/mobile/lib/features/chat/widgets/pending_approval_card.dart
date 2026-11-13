import 'package:flutter/material.dart';

import '../../../protocol/s03_messages.dart';

/// 聊天页里的待审批卡片；只显示安全摘要，不显示命令或路径。
class PendingApprovalCard extends StatelessWidget {
  const PendingApprovalCard({
    super.key,
    required this.approval,
    required this.onTap,
  });

  final ApprovalSummary approval;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      key: Key('pendingApproval_${approval.approvalId}'),
      child: ListTile(
        leading: const Icon(Icons.gpp_maybe_outlined),
        title: Text('${approval.toolName} 等待审批'),
        subtitle: Text(
          approval.agentId == null
              ? '点击查看完整请求'
              : '子代理 ${approval.agentId} · 点击查看',
        ),
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}