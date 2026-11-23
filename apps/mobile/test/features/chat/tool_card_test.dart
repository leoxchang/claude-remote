import 'package:claude_remote/domain/timeline.dart';
import 'package:claude_remote/features/chat/widgets/tool_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

TimelineTool tool({
  String name = 'Bash',
  Map<String, Object?> input = const {},
  String output = '',
  String? status,
}) {
  return TimelineTool(
    toolUseId: 'toolu_01',
    toolName: name,
    input: input,
    output: output,
    status: status,
  );
}

void main() {
  test('summarizes the tool input by tool name', () {
    expect(
      toolInputSummary(tool(input: {'command': 'ls -la'})),
      'ls -la',
    );
    expect(
      toolInputSummary(
        tool(name: 'Read', input: {'file_path': '/tmp/a.dart'}),
      ),
      '/tmp/a.dart',
    );
    expect(
      toolInputSummary(
        tool(name: 'Grep', input: {'pattern': 'TODO', 'path': 'lib'}),
      ),
      'TODO · lib',
    );
    expect(
      toolInputSummary(
        tool(name: 'SomeMcpTool', input: {'query': 'hello', 'n': 1}),
      ),
      'hello',
    );
    expect(toolInputSummary(tool()), isEmpty);
  });

  testWidgets('shows the tool input and status', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ToolCard(
            tool: tool(
              input: {'command': 'pwd'},
              output: '/tmp',
              status: 'succeeded',
            ),
          ),
        ),
      ),
    );

    expect(find.text('Bash'), findsOneWidget);
    expect(find.text('pwd'), findsOneWidget);
    expect(find.text('完成'), findsOneWidget);
    expect(find.text('/tmp'), findsOneWidget);
  });

  testWidgets('collapses long output until expanded', (tester) async {
    final output = List.generate(20, (index) => 'line $index').join('\n');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ToolCard(tool: tool(output: output, status: 'succeeded')),
        ),
      ),
    );

    expect(find.text('展开全部'), findsOneWidget);

    await tester.tap(find.byKey(const Key('toolToggleOutput')));
    await tester.pump();

    expect(find.text('收起'), findsOneWidget);
    expect(find.textContaining('line 19'), findsOneWidget);
  });
}