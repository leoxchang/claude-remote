import 'dart:async';

import 'package:claude_remote/features/recovery/recovery_controller.dart';
import 'package:claude_remote/features/recovery/recovery_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('background masks and drops late prompt results', () async {
    final gate = Completer<String>();
    final controller = RecoveryController(
      loadPromptText: (runId) => gate.future,
      requeueRun: (runId, sessionId, generation) async {},
      discardRun: (runId) async {},
      canStartIntent: (sessionId) async => true,
    );
    controller.registerRecoveryRuns([
      const RecoveryRunSummary(
        runId: 'run_1',
        sessionId: 's1',
        recoveryGeneration: 1,
      ),
    ]);
    final loading = controller.loadPrompt('run_1');
    controller.onLifecycle(AppLifecycleState.paused);
    gate.complete('S04_SECRET_PROMPT');
    await loading;
    expect(controller.promptOf('run_1'), isNull);
    expect(controller.masked, isTrue);
    expect(controller.canRequeue(controller.runs.first), isFalse);
  });

  testWidgets('masked page renders no prompt text', (tester) async {
    final controller = RecoveryController(
      loadPromptText: (runId) async => 'S04_SECRET_PROMPT',
      requeueRun: (runId, sessionId, generation) async {},
      discardRun: (runId) async {},
      canStartIntent: (sessionId) async => true,
    );
    controller.registerRecoveryRuns([
      const RecoveryRunSummary(
        runId: 'run_1',
        sessionId: 's1',
        recoveryGeneration: 1,
      ),
    ]);
    await controller.loadPrompt('run_1');
    await tester.pumpWidget(
      MaterialApp(home: RecoveryPage(controller: controller)),
    );
    expect(find.text('S04_SECRET_PROMPT'), findsOneWidget);

    controller.onLifecycle(AppLifecycleState.paused);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('recoveryPrivacyMask')), findsOneWidget);
    expect(find.text('S04_SECRET_PROMPT'), findsNothing);
  });
}
