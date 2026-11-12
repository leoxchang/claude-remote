import 'package:claude_remote/domain/workspace.dart';
import 'package:claude_remote/features/workspaces/workspace_controller.dart';
import 'package:claude_remote/features/workspaces/workspace_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

final class _FakeWorkspaceController extends WorkspaceController {
  _FakeWorkspaceController(this._initial);

  final WorkspaceViewState _initial;

  @override
  WorkspaceViewState build() => _initial;

  @override
  Future<void> refresh() async {}
}

Future<void> pumpWorkspacePage(
  WidgetTester tester, {
  required List<WorkspaceSummary> workspaces,
  SchedulerSummary? scheduler,
  String? error,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        workspaceControllerProvider.overrideWith(
          () => _FakeWorkspaceController(
            WorkspaceViewState(
              workspaces: workspaces,
              scheduler: scheduler,
              error: error,
            ),
          ),
        ),
      ],
      child: const MaterialApp(home: WorkspacePage()),
    ),
  );
  await tester.pump();
}

WorkspaceSummary workspace({required String name}) =>
    WorkspaceSummary(workspaceId: 'ws_${name.hashCode}', displayName: name);

void main() {
  testWidgets('workspace page exposes no path or authorization editor', (
    tester,
  ) async {
    await pumpWorkspacePage(
      tester,
      workspaces: [workspace(name: 'Fixture Alpha')],
      scheduler: const SchedulerSummary(
        maxActiveRuns: 2,
        activeRunCount: 1,
        queuedRunCount: 3,
        maxQueuedRuns: 100,
      ),
    );

    expect(find.text('Fixture Alpha'), findsOneWidget);
    expect(find.textContaining('/absolute/'), findsNothing);
    expect(find.byTooltip('添加项目'), findsNothing);
    expect(find.text('全局执行槽 1/2'), findsOneWidget);
  });

  testWidgets('shows a safe empty state without projects', (tester) async {
    await pumpWorkspacePage(tester, workspaces: const []);

    expect(find.text('还没有授权项目'), findsOneWidget);
    expect(find.textContaining('rootPath'), findsNothing);
  });

  testWidgets('shows a safe error message without internal details', (
    tester,
  ) async {
    await pumpWorkspacePage(
      tester,
      workspaces: const [],
      error: 'WORKSPACE_NOT_ALLOWED',
    );

    expect(find.text('项目不可用，请在本机重新授权'), findsOneWidget);
  });
}