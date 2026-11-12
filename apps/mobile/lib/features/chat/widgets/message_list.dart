import 'package:flutter/material.dart';

import '../../../domain/timeline.dart';
import 'tool_card.dart';

/// 时间线消息与工具卡片列表。
class MessageList extends StatelessWidget {
  const MessageList({
    super.key,
    required this.messages,
    required this.tools,
  });

  final List<TimelineMessage> messages;
  final List<TimelineTool> tools;

  @override
  Widget build(BuildContext context) {
    if (messages.isEmpty && tools.isEmpty) {
      return const Center(child: Text('还没有消息'));
    }
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        for (final message in messages)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Text(message.text),
          ),
        for (final tool in tools) ToolCard(tool: tool),
      ],
    );
  }
}