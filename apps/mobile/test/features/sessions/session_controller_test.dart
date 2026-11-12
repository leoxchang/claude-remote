import 'dart:convert';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/data/providers.dart';
import 'package:claude_remote/features/sessions/session_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../connection/fake_socket.dart';

String commandIdOf(String raw) => (jsonDecode(raw) as Map)['commandId'] as String;
String typeOf(String raw) => (jsonDecode(raw) as Map)['type'] as String;
Map<String, Object?> payloadOf(String raw) =>
    ((jsonDecode(raw) as Map)['payload'] as Map).cast<String, Object?>();

Map<String, Object?> sessionJson({
  String sessionId = 'session_01',
  String title = '修复测试',
  String status = 'idle',
  int queuedCount = 0,
}) {
  return {
    'sessionId': sessionId,
    'workspaceId': 'ws_alpha',
    'title': title,
    'claudeSessionId': null,
    'status': status,
    'activeRunId': null,
    'queuedCount': queuedCount,
    'createdAt': 1762432800000,
    'lastActivityAt': 1762432800000,
  };
}

void main() {
  late FakeAgentSocket socket;
  late CommandClient client;
  late ProviderContainer container;

  SessionListController controller() =>
      container.read(sessionListControllerProvider.notifier);
  SessionListState state() => container.read(sessionListControllerProvider);

  setUp(() {
    socket = FakeAgentSocket();
    client = CommandClient(socket);
    container = ProviderContainer(
      overrides: [
        commandClientProvider.overrideWith((ref) async => client),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  Future<void> showFirstPage() async {
    final loading = controller().loadFirstPage('ws_alpha');
    await pumpEventQueue();
    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(socket.sent.last),
        data: {
          'sessions': [sessionJson()],
          'nextCursor': 'cursor_2',
        },
      ),
    );
    await loading;
  }

  test('loads the first page with the workspace and default limit', () async {
    final loading = controller().loadFirstPage('ws_alpha');
    await pumpEventQueue();

    final frame = socket.sent.single;
    expect(typeOf(frame), 'session.list');
    expect(payloadOf(frame)['workspaceId'], 'ws_alpha');
    expect(payloadOf(frame)['limit'], 20);

    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(frame),
        data: {
          'sessions': [sessionJson()],
          'nextCursor': 'cursor_2',
        },
      ),
    );
    await loading;

    expect(state().sessions.single.title, '修复测试');
    expect(state().nextCursor, 'cursor_2');
    expect(state().workspaceId, 'ws_alpha');
  });

  test('appends the next page and keeps stable order', () async {
    await showFirstPage();
    final loading = controller().loadNextPage();
    await pumpEventQueue();

    final frame = socket.sent.last;
    expect(payloadOf(frame)['cursor'], 'cursor_2');

    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(frame),
        data: {
          'sessions': [
            sessionJson(sessionId: 'session_02', title: '阅读代码'),
          ],
          'nextCursor': null,
        },
      ),
    );
    await loading;

    expect(
      state().sessions.map((session) => session.sessionId).toList(),
      <String>['session_01', 'session_02'],
    );
    expect(state().nextCursor, isNull);
  });

  test('includeArchived is sent explicitly and replaces the page', () async {
    await showFirstPage();
    final loading = controller().setIncludeArchived(true);
    await pumpEventQueue();

    final frame = socket.sent.last;
    expect(payloadOf(frame)['includeArchived'], isTrue);

    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(frame),
        data: {
          'sessions': [
            sessionJson(sessionId: 'session_00', title: '旧会话', status: 'archived'),
          ],
          'nextCursor': null,
        },
      ),
    );
    await loading;

    expect(state().sessions.single.status, 'archived');
    expect(state().sessions.single.isArchived, isTrue);
  });

  test('surfaces INVALID_CURSOR without dropping the current list', () async {
    await showFirstPage();
    final loading = controller().loadNextPage();
    await pumpEventQueue();

    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(socket.sent.last),
        status: 'error',
        error: {'code': 'INVALID_CURSOR', 'message': 'INVALID_CURSOR'},
      ),
    );
    await loading;

    expect(state().error, 'INVALID_CURSOR');
    expect(state().sessions, hasLength(1));
    expect(
      SessionListController.messageFor('INVALID_CURSOR'),
      '列表已过期，请重新加载',
    );
  });

  test('create inserts the new summary at the top', () async {
    await showFirstPage();
    final creating = controller().create(title: '新任务');
    await pumpEventQueue();

    final frame = socket.sent.last;
    expect(typeOf(frame), 'session.create');
    expect(payloadOf(frame)['title'], '新任务');

    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(frame),
        data: sessionJson(sessionId: 'session_new', title: '新任务'),
      ),
    );
    final created = await creating;

    expect(created?.sessionId, 'session_new');
    expect(state().sessions.first.sessionId, 'session_new');
    expect(state().sessions, hasLength(2));
  });

  test('resume targets exactly one session', () async {
    final resuming = controller().resume('session_02');
    await pumpEventQueue();

    final frame = socket.sent.single;
    expect(typeOf(frame), 'session.resume');
    expect(payloadOf(frame)['sessionId'], 'session_02');

    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(frame),
        data: sessionJson(sessionId: 'session_02', title: '阅读代码'),
      ),
    );
    final resumed = await resuming;

    expect(resumed?.sessionId, 'session_02');
    expect(resumed?.title, '阅读代码');
  });

  test('rename and archive update the local summary', () async {
    await showFirstPage();

    final renaming = controller().rename('session_01', '重命名');
    await pumpEventQueue();
    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(socket.sent.last),
        data: sessionJson(title: '重命名'),
      ),
    );
    await renaming;
    expect(state().sessions.single.title, '重命名');

    final archiving = controller().archive('session_01');
    await pumpEventQueue();
    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(socket.sent.last),
        data: sessionJson(status: 'archived'),
      ),
    );
    await archiving;
    expect(state().sessions.single.isArchived, isTrue);
  });

  test('busy archive surfaces SESSION_BUSY with a safe message', () async {
    await showFirstPage();
    final archiving = controller().archive('session_01');
    await pumpEventQueue();

    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(socket.sent.last),
        status: 'error',
        error: {'code': 'SESSION_BUSY', 'message': 'SESSION_BUSY'},
      ),
    );
    await archiving;

    expect(state().error, 'SESSION_BUSY');
    expect(
      SessionListController.messageFor('SESSION_BUSY'),
      '会话仍在运行或排队，暂时不能归档',
    );
  });
}
