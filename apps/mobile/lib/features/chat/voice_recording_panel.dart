import 'package:flutter/material.dart';

import '../../voice/voice_input_controller.dart';
import '../../voice/voice_ui_state.dart';

/// 录音/识别面板：partial 只替换显示，不拼接。
final class VoiceRecordingPanel extends StatelessWidget {
  const VoiceRecordingPanel({super.key, required this.recording});

  final VoiceRecording recording;

  static String formatElapsed(Duration elapsed) {
    final seconds = elapsed.inSeconds;
    final minutes = seconds ~/ 60;
    final rest = (seconds % 60).toString().padLeft(2, '0');
    return '${minutes.toString().padLeft(2, '0')}:$rest';
  }

  @override
  Widget build(BuildContext context) {
    final partial = recording.partialText;
    final elapsed = recording.elapsed;
    return Container(
      key: const ValueKey('voice-recording-panel'),
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.graphic_eq, size: 16),
              const SizedBox(width: 6),
              Text(
                formatElapsed(elapsed),
                key: const ValueKey('voice-elapsed'),
              ),
              const Spacer(),
              Text(
                recording.speechDetected ? '正在识别' : '正在聆听',
                key: const ValueKey('voice-hint'),
              ),
            ],
          ),
          if (partial.isNotEmpty)
            Text(
              '正在识别：$partial',
              key: const ValueKey('voice-partial'),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          if (elapsed >= maxVoiceRecording)
            const Text(
              '已达到最长录音，正在完成识别',
              key: ValueKey('voice-max-duration'),
            ),
        ],
      ),
    );
  }
}