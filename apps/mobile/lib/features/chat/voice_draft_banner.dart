import 'package:flutter/material.dart';

/// 语音草稿横幅：提示结果属于哪个会话，并提供取消本次语音。
final class VoiceDraftBanner extends StatelessWidget {
  const VoiceDraftBanner({
    super.key,
    required this.message,
    required this.onDiscard,
  });

  final String message;
  final VoidCallback onDiscard;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('voice-draft-banner'),
      width: double.infinity,
      color: Theme.of(context).colorScheme.tertiaryContainer,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      child: Row(
        children: [
          const Icon(Icons.record_voice_over, size: 16),
          const SizedBox(width: 6),
          Expanded(child: Text(message)),
          TextButton(
            key: const ValueKey('voice-discard'),
            onPressed: onDiscard,
            child: const Text('取消本次语音'),
          ),
        ],
      ),
    );
  }
}