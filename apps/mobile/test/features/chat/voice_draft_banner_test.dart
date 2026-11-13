import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:claude_remote/features/chat/voice_draft_banner.dart';

void main() {
  testWidgets('shows the origin session message and discards on tap', (
    tester,
  ) async {
    var discarded = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: VoiceDraftBanner(
            message: '语音草稿已写入会话 session_1',
            onDiscard: () => discarded += 1,
          ),
        ),
      ),
    );
    expect(find.text('语音草稿已写入会话 session_1'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('voice-discard')));
    await tester.pump();
    expect(discarded, 1);
    expect(find.text('取消本次语音'), findsOneWidget);
  });
}