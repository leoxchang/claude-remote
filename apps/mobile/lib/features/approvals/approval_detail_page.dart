import 'package:flutter/material.dart';

import '../../connection/command_client.dart';
import '../../domain/approval.dart';
import '../../protocol/s03_messages.dart';
import 'approval_controller.dart';
import 'widgets/approval_privacy_mask.dart';
import 'widgets/bash_approval_view.dart';
import 'widgets/file_change_approval_view.dart';
import 'widgets/json_approval_view.dart';

/// 审批详情页：完整内容加载并校验后才允许一次。
class ApprovalDetailPage extends StatelessWidget {
  const ApprovalDetailPage({
    super.key,
    required this.controller,
    required this.summary,
  });

  final ApprovalController controller;
  final ApprovalSummary summary;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('${summary.toolName} 审批')),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, _) => _body(context),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final content = controller.approvalContentCache[summary.approvalId];
    final state = controller.stateOf(summary.approvalId);
    final online = controller.isOnline();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          summary.agentId == null ? summary.toolName : '${summary.toolName} · 子代理',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          online
              ? '有效至 ${_timeText(summary.expiresAt)}（仅提示）'
              : '可能已过期，重连确认',
          key: const Key('approvalExpiryHint'),
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const Divider(height: 32),
        if (controller.masked)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: ApprovalPrivacyMask(),
          )
        else if (state == ApprovalActionState.unknown)
          const Text(
            'Mac 已重启，旧审批失效，执行结果未知',
            key: Key('approvalUnknown'),
          )
        else if (content == null)
          _contentPlaceholder(context, state)
        else
          ..._contentSections(context, content),
        if (summary.defaultToNo) ...[
          const SizedBox(height: 16),
          Container(
            key: const Key('defaultToNoWarning'),
            padding: const EdgeInsets.all(12),
            color: Theme.of(context).colorScheme.errorContainer,
            child: const Text('该请求默认拒绝；允许一次需要额外确认。'),
          ),
        ],
        const SizedBox(height: 24),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                key: const Key('denyButton'),
                onPressed: controller.canDeny(summary)
                    ? () => _deny(context)
                    : null,
                child: const Text('拒绝'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: FilledButton(
                key: const Key('allowButton'),
                onPressed: controller.canAllow(summary)
                    ? () => _allow(context)
                    : null,
                child: const Text('允许一次'),
              ),
            ),
          ],
        ),
        if (state == ApprovalActionState.resolved) ...[
          const SizedBox(height: 12),
          const Text('审批已结束', key: Key('approvalResolved')),
        ],
      ],
    );
  }

  Widget _contentPlaceholder(BuildContext context, ApprovalActionState? state) {
    if (state == ApprovalActionState.error) {
      return const Text(
        '完整内容加载失败；仍可拒绝，允许已禁用',
        key: Key('approvalContentError'),
      );
    }
    if (state == ApprovalActionState.resolved) return const SizedBox.shrink();
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 24),
      child: Center(child: CircularProgressIndicator()),
    );
  }

  List<Widget> _contentSections(
    BuildContext context,
    VerifiedApprovalContent content,
  ) {
    final contextData = content.context;
    final decisionReason = contextData['decisionReason'];
    final blockedPath = contextData['blockedPath'];
    return [
      const Text('工作目录', style: TextStyle(fontWeight: FontWeight.bold)),
      SelectableText(
        content.workingDirectory,
        key: const Key('approvalWorkingDirectory'),
      ),
      const SizedBox(height: 16),
      _inputView(content),
      if (decisionReason is String) ...[
        const SizedBox(height: 16),
        const Text('触发原因', style: TextStyle(fontWeight: FontWeight.bold)),
        SelectableText(decisionReason),
      ],
      if (blockedPath is String) ...[
        const SizedBox(height: 16),
        const Text('受限路径', style: TextStyle(fontWeight: FontWeight.bold)),
        SelectableText(blockedPath),
      ],
      const SizedBox(height: 16),
      const Text(
        '内容 hash 已校验',
        key: Key('approvalHashVerified'),
        style: TextStyle(color: Colors.green),
      ),
    ];
  }

  Widget _inputView(VerifiedApprovalContent content) {
    switch (summary.toolName) {
      case 'Bash':
        return BashApprovalView(input: content.input);
      case 'Write':
      case 'Edit':
      case 'NotebookEdit':
        return FileChangeApprovalView(
          toolName: summary.toolName,
          input: content.input,
        );
      default:
        return JsonApprovalView(input: content.input);
    }
  }

  Future<void> _allow(BuildContext context) async {
    if (summary.defaultToNo) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('确认允许一次？'),
          content: const Text('该请求默认拒绝，请确认你已在上面核对完整内容。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('取消'),
            ),
            TextButton(
              key: const Key('confirmDefaultToNo'),
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('确认允许'),
            ),
          ],
        ),
      );
      if (confirmed != true || !context.mounted) return;
    }
    try {
      await controller.allowOnce(summary);
    } on Object catch (error) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_message(error))),
      );
    }
  }

  Future<void> _deny(BuildContext context) async {
    try {
      await controller.deny(summary);
    } on Object catch (error) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_message(error))),
      );
    }
  }

  String _message(Object error) {
    if (error is CommandFailure) {
      return switch (error.code) {
        'APPROVAL_DUPLICATE_AFTER_RESOLUTION' => '审批已结束，重复执行已阻止',
        'APPROVAL_EXPIRED' => '审批已过期',
        'APPROVAL_ALREADY_RESOLVED' => '审批已结束',
        'NOT_CONNECTED' => 'Mac 未连接',
        _ => '提交失败（${error.code}）',
      };
    }
    return '提交失败';
  }

  String _timeText(int epochMs) {
    final time = DateTime.fromMillisecondsSinceEpoch(epochMs);
    final hh = time.hour.toString().padLeft(2, '0');
    final mm = time.minute.toString().padLeft(2, '0');
    final ss = time.second.toString().padLeft(2, '0');
    return '$hh:$mm:$ss';
  }
}