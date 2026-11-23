import 'package:claude_remote/domain/timeline.dart';
import 'package:claude_remote/features/chat/widgets/message_list.dart';
import 'package:claude_remote/recovery/user_message.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('renders user prompts before the assistant reply', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MessageList(
            messages: [
              TimelineMessage(
                assistantMessageId: 'assistant_1',
                text: '回答',
                createdAt: 200,
              ),
            ],
            tools: [],
            userMessages: [
              UserMessage(
                sessionId: 'session_1',
                commandId: 'cmd_1',
                text: '问题',
                createdAt: 100,
              ),
            ],
          ),
        ),
      ),
    );

    expect(find.text('问题'), findsOneWidget);
    expect(find.text('回答'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('问题')).dy,
      lessThan(tester.getTopLeft(find.text('回答')).dy),
    );
  });

  testWidgets('interleaves tool cards with assistant messages by time', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MessageList(
            messages: [
              TimelineMessage(
                assistantMessageId: 'm1',
                text: '先看看目录',
                createdAt: 100,
              ),
              TimelineMessage(
                assistantMessageId: 'm2',
                text: '目录里有三个文件',
                createdAt: 300,
              ),
            ],
            tools: [
              TimelineTool(
                toolUseId: 'toolu_01',
                toolName: 'Bash',
                input: {'command': 'ls'},
                status: 'succeeded',
                output: 'a.txt',
                createdAt: 200,
              ),
            ],
          ),
        ),
      ),
    );

    expect(
      tester.getTopLeft(find.text('先看看目录')).dy,
      lessThan(tester.getTopLeft(find.text('Bash')).dy),
    );
    expect(
      tester.getTopLeft(find.text('Bash')).dy,
      lessThan(tester.getTopLeft(find.text('目录里有三个文件')).dy),
    );
  });

  testWidgets('renders assistant markdown headings and tables', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MessageList(
            messages: [
              TimelineMessage(
                assistantMessageId: 'm1',
                text:
                    '## 分布\n\n| 区域 | 数量 |\n| --- | --- |\n| agent | 45 |',
                createdAt: 1,
              ),
            ],
            tools: [],
          ),
        ),
      ),
    );

    expect(find.text('分布'), findsOneWidget);
    expect(find.text('区域'), findsOneWidget);
    expect(find.text('agent'), findsOneWidget);
    expect(find.textContaining('|---'), findsNothing);
  });

  testWidgets('dismisses the keyboard when the timeline is dragged', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MessageList(
            messages: [
              TimelineMessage(
                assistantMessageId: 'assistant_1',
                text: '回答',
                createdAt: 1,
              ),
            ],
            tools: [],
          ),
        ),
      ),
    );

    final listView = tester.widget<ListView>(find.byType(ListView));

    expect(
      listView.keyboardDismissBehavior,
      ScrollViewKeyboardDismissBehavior.onDrag,
    );
  });
}