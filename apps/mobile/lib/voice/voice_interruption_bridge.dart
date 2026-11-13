import 'dart:async';

import 'package:flutter/services.dart';

/// 原生音频中断事件；ended 不自动恢复录音。
enum VoiceInterruption { began, ended }

/// AVAudioSession 中断桥；iOS 通过 EventChannel 上报。
final class VoiceInterruptionBridge {
  VoiceInterruptionBridge({Stream<dynamic>? events})
    : _events =
          events ??
          const EventChannel(
            'claude_remote/s05_audio_interruption',
          ).receiveBroadcastStream();

  final Stream<dynamic> _events;

  Stream<VoiceInterruption> get events => _events
      .where((event) => event == 'began' || event == 'ended')
      .map(
        (event) => event == 'began'
            ? VoiceInterruption.began
            : VoiceInterruption.ended,
      );
}