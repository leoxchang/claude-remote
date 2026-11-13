import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../connection/chat_session_runtime.dart';
import '../../data/providers.dart';
import '../../protocol/s03_messages.dart';
import '../approvals/approval_controller.dart';
import '../approvals/approval_detail_page.dart';
import 'chat_controller.dart';
import 'widgets/composer.dart';
import 'widgets/message_list.dart';
import 'widgets/pending_approval_card.dart';
import 'widgets/queue_panel.dart';
import 'widgets/run_controls.dart';

/// S01 唯一聊天页：时间线、停止控制和 composer。
class ChatPage extends ConsumerStatefulWidget {
  const ChatPage({super.key});

  static const String routeName = '/chat';

  @override
  ConsumerState<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends ConsumerState<ChatPage>
    with WidgetsBindingObserver {
  final TextEditingController _text = TextEditingController();
  ChatSessionRuntime? _runtime;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_startRuntime());
  }

  Future<void> _startRuntime() async {
    try {
      final runtime = await ref.read(chatSessionRuntimeProvider.future);
      if (!mounted) return;
      _runtime = runtime;
      await runtime?.start();
    } on Object {
      if (mounted) {
        ref.read(chatControllerProvider.notifier).reportError('无法建立与 Mac 的连接');
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _runtime?.connection.onLifecycle(state);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_runtime?.dispose());
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(chatControllerProvider);
    final controller = ref.read(chatControllerProvider.notifier);
    final timeline = state.timeline;
    final approvals = ref.watch(approvalControllerProvider).value;
    final sessionId = controller.sessionId;
    return Scaffold(
      appBar: AppBar(title: const Text('Claude Remote')),
      body: Column(
        children: [
          if (state.snapshotTruncated)
            const _Banner(message: '仅保留最近摘要，完整记录暂不可下载'),
          if (state.error != null) _ErrorBar(message: state.error!),
          Expanded(
            child: MessageList(
              messages: timeline?.messages ?? const [],
              tools: timeline?.tools ?? const [],
            ),
          ),
          if (approvals != null && sessionId != null)
            _ApprovalCards(controller: approvals, sessionId: sessionId),
          if (state.composer == ComposerStatus.unknown)
            TextButton(
              onPressed: controller.retryUnknownCommand,
              child: const Text('结果未知，重试上一条'),
            ),
          QueuePanel(
            queue: state.queue,
            previews: state.queuePreviews,
            onRemove: (runId) => unawaited(controller.removeQueuedRun(runId)),
          ),
          RunControls(
            busy: state.busy,
            cancelling: state.cancelling,
            onStop: controller.cancelActiveRun,
          ),
          Composer(
            controller: _text,
            enabled: state.canSend,
            label: state.queueMode ? '排队' : '发送',
            onChanged: controller.updateDraft,
            onSend: () async {
              await controller.sendText();
              if (!mounted) return;
              if (ref.read(chatControllerProvider).draft.isEmpty) {
                _text.clear();
              }
            },
          ),
        ],
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: Theme.of(context).colorScheme.secondaryContainer,
      padding: const EdgeInsets.all(8),
      child: Text(message, textAlign: TextAlign.center),
    );
  }
}

class _ErrorBar extends StatelessWidget {
  const _ErrorBar({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: Theme.of(context).colorScheme.errorContainer,
      padding: const EdgeInsets.all(8),
      child: Text(message, textAlign: TextAlign.center),
    );
  }
}

/// 当前会话的待审批卡片；点击进入详情，不改变会话选择。
class _ApprovalCards extends StatelessWidget {
  const _ApprovalCards({required this.controller, required this.sessionId});

  final ApprovalController controller;
  final String sessionId;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final pending = controller.pendingForSession(sessionId);
        if (pending.isEmpty) return const SizedBox.shrink();
        return Column(
          children: [
            for (final summary in pending)
              PendingApprovalCard(
                approval: summary,
                onTap: () => _open(context, summary),
              ),
          ],
        );
      },
    );
  }

  void _open(BuildContext context, ApprovalSummary summary) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            ApprovalDetailPage(controller: controller, summary: summary),
      ),
    );
  }
}