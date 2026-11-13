import 'dart:async';

import 'package:claude_remote/features/recovery/recovery_controller.dart';
import 'package:claude_remote/features/recovery/recovery_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

RecoveryRunSummary run(String id, {int generation = 1}) {
  return RecoveryRunSummary(
    runId: id,
    sessionId: 's1',
    recoveryGeneration: generation,
    promptExpiresAt: 1762432800000,
  );
}

void main() {
  controllerExtras();
  testWidgets('requires viewing the prompt before requeue', (tester) async {
    final requeued = <String>[];
    final discarded = <String>[];
    final gate = Completer<bool>();
    final controller = RecoveryController(
      loadPromptText: (runId) async => '原 prompt $runId',
      requeueRun: (runId, sessionId, generation) async {
        requeued.add('$runId:$generation');
      },
      discardRun: (runId) async => discarded.add(runId),
      canStartIntent: (sessionId) => gate.future,
    );
    controller.registerRecoveryRuns([run('run_1'), run('run_2', generation: 2)]);

    await tester.pumpWidget(
      MaterialApp(home: RecoveryPage(controller: controller)),
    );

    FilledButton requeueButton(String id) => tester.widget<FilledButton>(
      find.byKey(Key('requeue-$id')),
    );

    expect(requeueButton('run_1').onPressed, isNull);
    expect(find.byKey(const Key('discard-run_1')), findsOneWidget);

    await tester.tap(find.byKey(const Key('loadPrompt-run_1')));
    await tester.pumpAndSettle();
    expect(find.text('原 prompt run_1'), findsOneWidget);
    expect(requeueButton('run_1').onPressed, isNotNull);

    gate.complete(true);
    await tester.tap(find.byKey(const Key('requeue-run_1')));
    await tester.pumpAndSettle();
    expect(requeued, ['run_1:1']);
    expect(find.byKey(const Key('requeue-run_1')), findsNothing);
    expect(find.byKey(const Key('requeue-run_2')), findsOneWidget);
  });

  testWidgets('discard works without loading the prompt', (tester) async {
    final discarded = <String>[];
    final controller = RecoveryController(
      loadPromptText: (runId) async => 'prompt',
      requeueRun: (runId, sessionId, generation) async {},
      discardRun: (runId) async => discarded.add(runId),
      canStartIntent: (sessionId) async => true,
    );
    controller.registerRecoveryRuns([run('run_1')]);
    await tester.pumpWidget(
      MaterialApp(home: RecoveryPage(controller: controller)),
    );
    await tester.tap(find.byKey(const Key('discard-run_1')));
    await tester.pumpAndSettle();
    expect(discarded, ['run_1']);
    expect(find.byKey(const Key('recoveryEmpty')), findsOneWidget);
  });

  testWidgets('requeue is blocked when the gate is busy or offline', (tester) async {
    var online = false;
    final controller = RecoveryController(
      loadPromptText: (runId) async => 'prompt',
      requeueRun: (runId, sessionId, generation) async {},
      discardRun: (runId) async {},
      canStartIntent: (sessionId) async => false,
      isOnline: () => online,
    )..registerRecoveryRuns([run('run_1')]);
    await tester.pumpWidget(
      MaterialApp(home: RecoveryPage(controller: controller)),
    );
    await tester.tap(find.byKey(const Key('loadPrompt-run_1')));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<FilledButton>(find.byKey(const Key('requeue-run_1')))
          .onPressed,
      isNull,
    );
    online = true;
    controller.registerRecoveryRuns([run('run_1')]);
    await tester.pump();
    var attempts = 0;
    final instrumented = RecoveryController(
      loadPromptText: (runId) async => 'prompt',
      requeueRun: (runId, sessionId, generation) async => attempts += 1,
      discardRun: (runId) async {},
      canStartIntent: (sessionId) async => false,
      isOnline: () => true,
    )..registerRecoveryRuns([run('run_1')]);
    await instrumented.loadPrompt('run_1');
    await instrumented.requeue('run_1');
    expect(attempts, 0);
  });

  testWidgets('unknown command banner states the discard warning', (tester) async {
    var confirmed = 0;
    var discarded = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: UnknownCommandBanner(
            message: '结果未知',
            onConfirm: () => confirmed += 1,
            onDiscard: () => discarded += 1,
          ),
        ),
      ),
    );
    expect(
      find.textContaining('不会撤销 Mac 已接受的执行'),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const Key('confirmRetryButton')));
    await tester.tap(find.byKey(const Key('discardLocalButton')));
    expect(confirmed, 1);
    expect(discarded, 1);
  });
}

void controllerExtras() {
  test('resume, clearAll and error reporting', () async {
    final requeued = <String>[];
    final controller = RecoveryController(
      loadPromptText: (runId) async => 'p',
      requeueRun: (runId, sessionId, generation) async {
        requeued.add(runId);
        throw StateError('offline');
      },
      discardRun: (runId) async => throw StateError('offline'),
      canStartIntent: (sessionId) async => true,
    );
    controller.registerRecoveryRuns([
      const RecoveryRunSummary(
        runId: 'run_1',
        sessionId: 's1',
        recoveryGeneration: 1,
      ),
    ]);
    controller.onLifecycle(AppLifecycleState.paused);
    controller.registerRecoveryRuns([
      const RecoveryRunSummary(
        runId: 'run_1',
        sessionId: 's1',
        recoveryGeneration: 1,
      ),
    ]);
    expect(controller.runs, hasLength(1));
    controller.onResume([
      const RecoveryRunSummary(
        runId: 'run_1',
        sessionId: 's1',
        recoveryGeneration: 1,
      ),
    ]);
    expect(controller.masked, isFalse);
    await controller.loadPrompt('run_1');
    await controller.requeue('run_1');
    expect(requeued, ['run_1']);
    expect(controller.lastError, isNotNull);
    await controller.discard('run_1');
    expect(controller.lastError, isNotNull);
    controller.clearAll();
    expect(controller.runs, isEmpty);
  });
}
