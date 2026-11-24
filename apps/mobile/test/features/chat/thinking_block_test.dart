import 'package:claude_remote/domain/timeline.dart';
import 'package:claude_remote/features/chat/widgets/thinking_block.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('keeps the thinking text collapsed until tapped', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: ThinkingBlock(
            thinking: TimelineThinking(
              assistantMessageId: 'm1',
              text: '先看看目录结构',
              completed: true,
            ),
          ),
        ),
      ),
    );

    expect(find.textContaining('思考过程'), findsOneWidget);
    expect(find.textContaining('已完成'), findsOneWidget);
    expect(find.text('先看看目录结构'), findsNothing);

    await tester.tap(find.byKey(const Key('thinkingToggle')));
    await tester.pump();

    expect(find.text('先看看目录结构'), findsOneWidget);
  });

  testWidgets('shows the streaming state while thinking', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: ThinkingBlock(
            thinking: TimelineThinking(
              assistantMessageId: 'm1',
              text: '正在推理',
            ),
          ),
        ),
      ),
    );

    expect(find.textContaining('思考中'), findsOneWidget);
  });
}