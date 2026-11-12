import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/features/chat/widgets/queue_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

QueuedRunSummary queuedRun(String runId) => QueuedRunSummary(
      runId: runId,
      commandId: 'cmd_1',
      enqueuedAt: 1762432800000,
    );

Future<List<String>> pumpQueue(
  WidgetTester tester, {
  required List<QueuedRunSummary> queue,
  Map<String, String> previews = const <String, String>{},
}) async {
  final removed = <String>[];
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: QueuePanel(
          queue: queue,
          previews: previews,
          onRemove: removed.add,
        ),
      ),
    ),
  );
  return removed;
}

void main() {
  testWidgets('cold queued card is anonymous and only offers removal', (
    tester,
  ) async {
    final removed = await pumpQueue(
      tester,
      queue: [queuedRun('run_12345678')],
    );

    expect(find.text('排队任务'), findsOneWidget);
    expect(find.textContaining('run_1234'), findsOneWidget);
    expect(find.text('执行结果未知'), findsNothing);
    expect(find.textContaining('prompt secret'), findsNothing);
    expect(find.text('停止当前不会清除队列'), findsOneWidget);

    await tester.tap(find.byTooltip('移除'));
    expect(removed, <String>['run_12345678']);
  });

  testWidgets('shows a local draft preview when one still exists', (
    tester,
  ) async {
    await pumpQueue(
      tester,
      queue: [queuedRun('run_1')],
      previews: {'run_1': 'safe preview'},
    );

    expect(find.text('safe preview'), findsOneWidget);
    expect(find.text('排队任务'), findsNothing);
  });

  testWidgets('renders nothing without queued runs', (tester) async {
    await pumpQueue(tester, queue: const []);

    expect(find.text('队列'), findsNothing);
    expect(find.byTooltip('移除'), findsNothing);
  });
}