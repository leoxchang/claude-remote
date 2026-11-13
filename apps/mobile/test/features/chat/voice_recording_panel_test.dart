import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:claude_remote/features/chat/voice_recording_panel.dart';
import 'package:claude_remote/voice/voice_ui_state.dart';

Widget wrap(VoiceRecording recording) {
  return MaterialApp(
    home: Scaffold(body: VoiceRecordingPanel(recording: recording)),
  );
}

void main() {
  testWidgets('replaces the partial snapshot instead of appending', (
    tester,
  ) async {
    await tester.pumpWidget(
      wrap(
        const VoiceRecording(
          asrStreamId: 'asr_1',
          elapsed: Duration(seconds: 12),
          partialText: '你好',
          speechDetected: true,
        ),
      ),
    );
    expect(find.text('正在识别：你好'), findsOneWidget);
    expect(find.text('00:12'), findsOneWidget);
    expect(find.text('正在识别'), findsOneWidget);

    await tester.pumpWidget(
      wrap(
        const VoiceRecording(
          asrStreamId: 'asr_1',
          elapsed: Duration(seconds: 13),
          partialText: '你好世界',
          speechDetected: true,
        ),
      ),
    );
    expect(find.text('正在识别：你好世界'), findsOneWidget);
    expect(find.textContaining('你好你好'), findsNothing);
  });

  testWidgets('shows the listening hint before speech is detected', (
    tester,
  ) async {
    await tester.pumpWidget(
      wrap(
        const VoiceRecording(
          asrStreamId: 'asr_1',
          elapsed: Duration(seconds: 1),
          partialText: '',
          speechDetected: false,
        ),
      ),
    );
    expect(find.text('正在聆听'), findsOneWidget);
  });

  testWidgets('shows the maximum duration copy at 60 seconds', (tester) async {
    await tester.pumpWidget(
      wrap(
        const VoiceRecording(
          asrStreamId: 'asr_1',
          elapsed: Duration(seconds: 60),
          partialText: '',
          speechDetected: true,
        ),
      ),
    );
    expect(find.text('已达到最长录音，正在完成识别'), findsOneWidget);
  });
}