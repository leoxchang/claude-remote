import 'package:flutter/material.dart';

import 'recovery_controller.dart';

/// 恢复页：显式查看原 prompt、requeue 或丢弃；不自动执行。
final class RecoveryPage extends StatelessWidget {
  const RecoveryPage({super.key, required this.controller});

  final RecoveryController controller;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('待恢复任务')),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          if (controller.masked) {
            return const _RecoveryMask();
          }
          final runs = controller.runs;
          if (runs.isEmpty) {
            return const Center(
              child: Text('没有待恢复的任务', key: Key('recoveryEmpty')),
            );
          }
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const Text('恢复执行需要你确认原 prompt；不会自动继续旧任务。'),
              if (controller.lastError != null)
                Text(
                  controller.lastError!,
                  key: const Key('recoveryError'),
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
              const SizedBox(height: 12),
              for (final run in runs) _RecoveryCard(controller: controller, run: run),
            ],
          );
        },
      ),
    );
  }
}

final class _RecoveryCard extends StatelessWidget {
  const _RecoveryCard({required this.controller, required this.run});

  final RecoveryController controller;
  final RecoveryRunSummary run;

  @override
  Widget build(BuildContext context) {
    final prompt = controller.promptOf(run.runId);
    final loading = controller.isLoading(run.runId);
    return Card(
      key: Key('recoveryCard-${run.runId}'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('run ${run.runId} · 第 ${run.recoveryGeneration} 代'),
            if (run.promptExpiresAt != null)
              Text(
                'prompt 有效至 ${_time(run.promptExpiresAt!)}（仅提示）',
                key: Key('recoveryExpiry-${run.runId}'),
              ),
            const SizedBox(height: 8),
            if (loading)
              const LinearProgressIndicator()
            else if (prompt == null)
              OutlinedButton(
                key: Key('loadPrompt-${run.runId}'),
                onPressed: () => controller.loadPrompt(run.runId),
                child: const Text('查看原 prompt'),
              )
            else
              SelectableText(
                prompt,
                key: Key('recoveryPrompt-${run.runId}'),
                style: const TextStyle(fontFamily: 'monospace'),
              ),
            const SizedBox(height: 8),
            Row(
              children: [
                OutlinedButton(
                  key: Key('discard-${run.runId}'),
                  onPressed: () => controller.discard(run.runId),
                  child: const Text('放弃本地重试'),
                ),
                const SizedBox(width: 12),
                FilledButton(
                  key: Key('requeue-${run.runId}'),
                  onPressed: controller.canRequeue(run)
                      ? () => controller.requeue(run.runId)
                      : null,
                  child: const Text('恢复会话'),
                ),
              ],
            ),
            const SizedBox(height: 4),
            const Text(
              '恢复会话会重新排队；Claude 上下文可能只保留部分内容。',
              style: TextStyle(fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }

  String _time(int epochMs) {
    final time = DateTime.fromMillisecondsSinceEpoch(epochMs);
    final hh = time.hour.toString().padLeft(2, '0');
    final mm = time.minute.toString().padLeft(2, '0');
    return '$hh:$mm';
  }
}

final class _RecoveryMask extends StatelessWidget {
  const _RecoveryMask();

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('recoveryPrivacyMask'),
      color: Theme.of(context).colorScheme.surface,
      alignment: Alignment.center,
      child: const Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.lock_outline, size: 40),
          SizedBox(height: 12),
          Text('恢复内容已隐藏'),
          SizedBox(height: 4),
          Text('回到前台后重新加载'),
        ],
      ),
    );
  }
}

/// 底部未知/未确认命令提示；放弃不会撤销 Mac 已接受的执行。
final class UnknownCommandBanner extends StatelessWidget {
  const UnknownCommandBanner({
    super.key,
    required this.message,
    required this.onConfirm,
    required this.onDiscard,
  });

  final String message;
  final VoidCallback onConfirm;
  final VoidCallback onDiscard;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('unknownCommandBanner'),
      padding: const EdgeInsets.all(12),
      color: Theme.of(context).colorScheme.errorContainer,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(message),
          const Text(
            '放弃本地重试不会撤销 Mac 已接受的执行；重新发送请使用同一条命令。',
            style: TextStyle(fontSize: 12),
          ),
          Row(
            children: [
              TextButton(
                key: const Key('confirmRetryButton'),
                onPressed: onConfirm,
                child: const Text('确认查询/重试'),
              ),
              TextButton(
                key: const Key('discardLocalButton'),
                onPressed: onDiscard,
                child: const Text('放弃本地重试'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}