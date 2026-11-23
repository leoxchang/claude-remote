import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../../../domain/timeline.dart';
import '../../../recovery/user_message.dart';
import 'tool_card.dart';

/// 时间线消息、本地提问与工具卡片列表。
class MessageList extends StatelessWidget {
  const MessageList({
    super.key,
    required this.messages,
    required this.tools,
    this.userMessages = const <UserMessage>[],
  });

  final List<TimelineMessage> messages;
  final List<TimelineTool> tools;
  final List<UserMessage> userMessages;

  @override
  Widget build(BuildContext context) {
    if (messages.isEmpty && tools.isEmpty && userMessages.isEmpty) {
      return const Center(child: Text('还没有消息'));
    }
    // 助手文本、工具调用与本地提问按时间合并，还原 Claude Code 的执行顺序。
    final entries = <({int at, int order, Widget child})>[
      for (final message in userMessages)
        (
          at: message.createdAt,
          order: 0,
          child: _UserMessageBubble(
            text: message.text,
            attachmentPaths: message.attachmentPaths,
          ),
        ),
      for (final message in messages)
        (
          at: message.createdAt,
          order: 1,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: _AssistantMarkdown(text: message.text),
          ),
        ),
      for (final tool in tools)
        (
          at: tool.createdAt,
          order: 2,
          child: ToolCard(tool: tool),
        ),
    ];
    entries.sort((left, right) {
      final byTime = left.at.compareTo(right.at);
      return byTime != 0 ? byTime : left.order.compareTo(right.order);
    });
    return ListView(
      padding: const EdgeInsets.all(12),
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      children: [for (final entry in entries) entry.child],
    );
  }
}

/// 助手回复按 GitHub 风格 Markdown 渲染；流式更新时随文本增量重绘。
class _AssistantMarkdown extends StatelessWidget {
  const _AssistantMarkdown({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    if (text.trim().isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final base = MarkdownStyleSheet.fromTheme(theme);
    final style = base.copyWith(
      p: theme.textTheme.bodyMedium?.copyWith(height: 1.55),
      pPadding: const EdgeInsets.only(bottom: 6),
      h1: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600),
      h2: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
      h3: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
      h1Padding: const EdgeInsets.only(top: 8, bottom: 4),
      h2Padding: const EdgeInsets.only(top: 8, bottom: 4),
      h3Padding: const EdgeInsets.only(top: 6, bottom: 4),
      code: TextStyle(
        fontFamily: 'Menlo',
        fontSize: 13,
        backgroundColor: colors.surfaceContainerHighest,
      ),
      codeblockPadding: const EdgeInsets.all(10),
      codeblockDecoration: BoxDecoration(
        color: colors.surfaceContainerHighest.withValues(alpha: 0.7),
        borderRadius: BorderRadius.circular(8),
      ),
      blockquoteDecoration: BoxDecoration(
        color: colors.surfaceContainerHighest.withValues(alpha: 0.4),
        border: Border(
          left: BorderSide(color: colors.outlineVariant, width: 3),
        ),
      ),
      blockquotePadding: const EdgeInsets.all(8),
      listBullet: theme.textTheme.bodyMedium,
      tableBorder: TableBorder.all(
        color: colors.outlineVariant,
        width: 0.5,
      ),
      tableCellsPadding: const EdgeInsets.symmetric(
        horizontal: 8,
        vertical: 6,
      ),
      tableHead: theme.textTheme.bodySmall?.copyWith(
        fontWeight: FontWeight.w600,
      ),
      tableBody: theme.textTheme.bodySmall,
      horizontalRuleDecoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: colors.outlineVariant, width: 1),
        ),
      ),
    );
    return MarkdownBody(
      data: text,
      selectable: true,
      styleSheet: style,
    );
  }
}

/// 用户提问气泡；正文与图片都只来自本机存储。
class _UserMessageBubble extends StatelessWidget {
  const _UserMessageBubble({
    required this.text,
    this.attachmentPaths = const <String>[],
  });

  final String text;
  final List<String> attachmentPaths;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        constraints: const BoxConstraints(maxWidth: 320),
        decoration: BoxDecoration(
          color: colors.primaryContainer,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final path in attachmentPaths)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Image.file(
                    File(path),
                    width: 200,
                    fit: BoxFit.cover,
                    errorBuilder: (_, _, _) => const SizedBox(
                      width: 200,
                      height: 96,
                      child: Center(child: Icon(Icons.broken_image_outlined)),
                    ),
                  ),
                ),
              ),
            if (text.isNotEmpty)
              Text(
                text,
                style: TextStyle(color: colors.onPrimaryContainer),
              ),
          ],
        ),
      ),
    );
  }
}