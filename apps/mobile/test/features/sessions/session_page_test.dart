import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/features/sessions/session_controller.dart';
import 'package:claude_remote/features/sessions/session_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

final class FakeSessionListController extends SessionListController {
  FakeSessionListController(this._initial);

  final SessionListState _initial;

  int createCalls = 0;
  String? resumed;
  String? archived;

  @override
  SessionListState build() => _initial;

  @override
  Future<void> loadFirstPage(String workspaceId) async {}

  @override
  Future<void> setIncludeArchived(bool value) async {
    state = state.copyWith(includeArchived: value);
  }

  @override
  Future<SessionSummary?> create({String? title}) async {
    createCalls += 1;
    return null;
  }

  @override
  Future<SessionSummary?> resume(String sessionId) async {
    resumed = sessionId;
    return null;
  }

  @override
  Future<void> archive(String sessionId) async {
    archived = sessionId;
  }
}

SessionSummary summary({
  String sessionId = 'session_01',
  String title = '修复测试',
  String status = 'idle',
  int queuedCount = 0,
}) {
  return SessionSummary(
    sessionId: sessionId,
    workspaceId: 'ws_alpha',
    title: title,
    createdAt: 1762432800000,
    lastActivityAt: 1762432800000,
    status: status,
    queuedCount: queuedCount,
  );
}

Future<FakeSessionListController> pumpSessionPage(
  WidgetTester tester, {
  required List<SessionSummary> sessions,
  String? error,
  bool includeArchived = false,
}) async {
  final fake = FakeSessionListController(
    SessionListState(
      workspaceId: 'ws_alpha',
      sessions: sessions,
      includeArchived: includeArchived,
      error: error,
    ),
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sessionListControllerProvider.overrideWith(() => fake),
      ],
      child: const MaterialApp(
        home: SessionPage(workspaceId: 'ws_alpha', workspaceName: 'Fixture Alpha'),
      ),
    ),
  );
  await tester.pump();
  return fake;
}

void main() {
  testWidgets('lists active sessions without management affordances', (
    tester,
  ) async {
    await pumpSessionPage(
      tester,
      sessions: [
        summary(title: '修复测试', status: 'running'),
        summary(sessionId: 'session_02', title: '阅读代码', status: 'queued', queuedCount: 2),
      ],
    );

    expect(find.text('修复测试'), findsOneWidget);
    expect(find.text('阅读代码'), findsOneWidget);
    expect(find.text('运行中'), findsOneWidget);
    expect(find.text('排队 2'), findsOneWidget);
    expect(find.text('新建会话'), findsOneWidget);
    expect(find.textContaining('/absolute/'), findsNothing);
    expect(find.text('永久删除'), findsNothing);
    expect(find.text('取消归档'), findsNothing);
  });

  testWidgets('archived sessions appear only after toggling the filter', (
    tester,
  ) async {
    await pumpSessionPage(
      tester,
      sessions: [
        summary(),
        summary(sessionId: 'session_old', title: '旧会话', status: 'archived'),
      ],
    );

    expect(find.text('旧会话'), findsNothing);
    expect(find.text('显示已归档'), findsOneWidget);

    await tester.tap(find.text('显示已归档'));
    await tester.pumpAndSettle();

    expect(find.text('已归档会话'), findsOneWidget);
    expect(find.text('旧会话'), findsOneWidget);
    expect(find.text('隐藏已归档'), findsOneWidget);
  });

  testWidgets('an archived session has no actions', (tester) async {
    await pumpSessionPage(
      tester,
      sessions: [
        summary(sessionId: 'session_old', title: '旧会话', status: 'archived'),
      ],
      includeArchived: true,
    );

    expect(find.byType(PopupMenuButton<String>), findsNothing);

    await tester.tap(find.text('旧会话'));
    await tester.pump();
    expect(find.byType(PopupMenuButton<String>), findsNothing);
  });

  testWidgets('create button calls the controller', (tester) async {
    final fake = await pumpSessionPage(tester, sessions: [summary()]);

    await tester.tap(find.text('新建会话'));
    await tester.pump();

    expect(fake.createCalls, 1);
  });

  testWidgets('tapping a session resumes exactly that session', (tester) async {
    final fake = await pumpSessionPage(
      tester,
      sessions: [summary(sessionId: 'session_02')],
    );

    await tester.tap(find.text('修复测试'));
    await tester.pump();

    expect(fake.resumed, 'session_02');
  });

  testWidgets('busy archive error is shown as a safe message', (tester) async {
    await pumpSessionPage(
      tester,
      sessions: [summary()],
      error: 'SESSION_BUSY',
    );

    expect(find.text('会话仍在运行或排队，暂时不能归档'), findsOneWidget);
  });

  testWidgets('shows the empty state', (tester) async {
    await pumpSessionPage(tester, sessions: const []);

    expect(find.text('还没有会话'), findsOneWidget);
  });
}