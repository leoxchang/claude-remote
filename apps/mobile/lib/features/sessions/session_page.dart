import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../domain/session.dart';
import '../chat/chat_controller.dart';
import '../chat/chat_page.dart';
import 'session_controller.dart';

/// 某项目下的会话列表；创建、恢复、改名与归档都在这里完成。
class SessionPage extends ConsumerStatefulWidget {
  const SessionPage({
    super.key,
    required this.workspaceId,
    this.workspaceName,
  });

  final String workspaceId;
  final String? workspaceName;

  @override
  ConsumerState<SessionPage> createState() => _SessionPageState();
}

class _SessionPageState extends ConsumerState<SessionPage> {
  @override
  void initState() {
    super.initState();
    unawaited(
      ref
          .read(sessionListControllerProvider.notifier)
          .loadFirstPage(widget.workspaceId),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(sessionListControllerProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.workspaceName ?? '会话'),
        actions: [
          TextButton(
            onPressed: () => ref
                .read(sessionListControllerProvider.notifier)
                .setIncludeArchived(!state.includeArchived),
            child: Text(state.includeArchived ? '隐藏已归档' : '显示已归档'),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () =>
            ref.read(sessionListControllerProvider.notifier).create(),
        icon: const Icon(Icons.add),
        label: const Text('新建会话'),
      ),
      body: _body(state),
    );
  }

  Widget _body(SessionListState state) {
    final archived = state.includeArchived ? state.archivedSessions : const <SessionSummary>[];
    final empty = state.activeSessions.isEmpty && archived.isEmpty;
    return ListView(
      padding: const EdgeInsets.only(bottom: 96),
      children: [
        if (state.error != null)
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(SessionListController.messageFor(state.error!)),
          ),
        if (empty && !state.loading)
          const Padding(
            padding: EdgeInsets.all(32),
            child: Center(child: Text('还没有会话')),
          ),
        for (final session in state.activeSessions) _tile(session),
        if (archived.isNotEmpty) ...[
          const Divider(),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Text('已归档会话'),
          ),
          for (final session in archived) _tile(session),
        ],
        if (state.nextCursor != null)
          TextButton(
            onPressed: () => ref
                .read(sessionListControllerProvider.notifier)
                .loadNextPage(),
            child: const Text('加载更多'),
          ),
      ],
    );
  }

  Widget _tile(SessionSummary session) {
    return ListTile(
      title: Text(session.title),
      subtitle: Text(_statusLabel(session)),
      onTap: session.isArchived ? null : () => _openChat(session.sessionId),
      trailing: session.isArchived
          ? null
          : PopupMenuButton<String>(
              onSelected: (value) {
                if (value == 'rename') unawaited(_rename(session));
                if (value == 'archive') unawaited(_archive(session.sessionId));
              },
              itemBuilder: (_) => const [
                PopupMenuItem<String>(value: 'rename', child: Text('重命名')),
                PopupMenuItem<String>(value: 'archive', child: Text('归档')),
              ],
            ),
    );
  }

  String _statusLabel(SessionSummary session) {
    if (session.isArchived) return '已归档';
    if (session.status == 'running') return '运行中';
    if (session.status == 'queued') return '排队 ${session.queuedCount}';
    return '空闲';
  }

  Future<void> _openChat(String sessionId) async {
    final summary = await ref
        .read(sessionListControllerProvider.notifier)
        .resume(sessionId);
    if (summary == null || !mounted) return;
    ref.read(chatControllerProvider.notifier).attachSession(summary.sessionId);
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const ChatPage()),
    );
  }

  Future<void> _rename(SessionSummary session) async {
    final controller = TextEditingController(text: session.title);
    final title = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('重命名会话'),
        content: TextField(controller: controller, autofocus: true),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () =>
                Navigator.of(dialogContext).pop(controller.text.trim()),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (title == null || title.isEmpty) return;
    await ref
        .read(sessionListControllerProvider.notifier)
        .rename(session.sessionId, title);
  }

  Future<void> _archive(String sessionId) {
    return ref.read(sessionListControllerProvider.notifier).archive(sessionId);
  }
}