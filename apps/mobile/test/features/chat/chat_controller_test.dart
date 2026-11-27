import 'dart:convert';
import 'dart:io';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/connection_controller.dart';
import 'package:claude_remote/data/attachment_upload.dart';
import 'package:claude_remote/data/providers.dart';
import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/features/chat/chat_controller.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:claude_remote/recovery/user_message.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../connection/fake_socket.dart';

String lastCommandId(FakeAgentSocket socket) {
  final decoded = jsonDecode(socket.sent.last) as Map<String, dynamic>;
  return decoded['commandId'] as String;
}

String lastCommandType(FakeAgentSocket socket) {
  final decoded = jsonDecode(socket.sent.last) as Map<String, dynamic>;
  return decoded['type'] as String;
}

/// S04：queued 首次结果之后，只有 run.started 才让 run 变为活跃。
void emitRunStarted(ChatController chat, String runId, {int seq = 1}) {
  chat.mergeEvent(
    TimelineEvent(
      messageId: 'msg_started_$seq',
      timestamp: 1,
      type: 'run.started',
      payload: const {'status': 'starting'},
      eventId: 'event_started_$seq',
      sessionId: 'session_01',
      seq: seq,
      runId: runId,
    ),
  );
}

void main() {
  late FakeAgentSocket socket;
  late CommandClient client;
  late ProviderContainer container;

  ChatController controller() =>
      container.read(chatControllerProvider.notifier);

  ChatState state() => container.read(chatControllerProvider);

  setUp(() {
    socket = FakeAgentSocket();
    client = CommandClient(socket);
    container = ProviderContainer(
      overrides: [
        commandClientProvider.overrideWith((ref) async => client),
      ],
    );
    final chat = controller();
    chat.attachSession('session_01');
    chat.setConnection(ConnectionStatus.ready);
  });

  tearDown(() async {
    await client.dispose();
    await socket.close();
    container.dispose();
  });

  test('rejects a blank draft without sending', () async {
    await controller().sendText();

    expect(socket.sent, isEmpty);
    expect(state().error, contains('请输入内容'));
  });

  test('rejects a draft above 16 KiB before sending', () async {
    controller().updateDraft('a' * (maxPromptBytes + 1));

    await controller().sendText();

    expect(socket.sent, isEmpty);
    expect(state().error, contains('16 KiB'));
  });

  test('blocks sending while offline', () async {
    controller().setConnection(ConnectionStatus.disconnected);
    controller().updateDraft('hello');

    await controller().sendText();

    expect(socket.sent, isEmpty);
    expect(state().error, contains('Mac 未连接'));
  });

  test('blocks sending while the timeline is syncing', () async {
    controller().setSyncing(true);
    controller().updateDraft('hello');

    await controller().sendText();

    expect(socket.sent, isEmpty);
    expect(state().error, contains('同步'));
  });

  test('sends prompt.send and clears the draft on success', () async {
    controller().updateDraft('hello');
    final future = controller().sendText();
    await pumpEventQueue();

    expect(lastCommandType(socket), 'prompt.send');
    socket.emitMessage(
      commandResult(commandId: lastCommandId(socket), data: {'sessionId': 'session_01', 'runId': 'run_01', 'status': 'queued'}),
    );
    await future;
    emitRunStarted(controller(), 'run_01');

    expect(state().draft, isEmpty);
    expect(state().activeRunId, 'run_01');
    expect(state().busy, isTrue);
  });

  test('does not show the queued run twice when run.queued arrives first', () async {
    controller().updateDraft('hello');
    final future = controller().sendText();
    await pumpEventQueue();

    controller().mergeEvent(
      TimelineEvent(
        messageId: 'msg_queued',
        timestamp: 1,
        type: 'run.queued',
        payload: const {'enqueuedAt': 1},
        eventId: 'event_queued',
        sessionId: 'session_01',
        seq: 1,
        runId: 'run_01',
      ),
    );
    expect(state().queue, hasLength(1));

    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        data: {
          'sessionId': 'session_01',
          'runId': 'run_01',
          'status': 'queued',
        },
      ),
    );
    await future;

    expect(state().queue, hasLength(1));
    expect(state().queue.single.runId, 'run_01');
  });

  test('does not re-queue a run that already started', () async {
    controller().updateDraft('hello');
    final future = controller().sendText();
    await pumpEventQueue();

    controller().mergeEvent(
      TimelineEvent(
        messageId: 'msg_queued',
        timestamp: 1,
        type: 'run.queued',
        payload: const {'enqueuedAt': 1},
        eventId: 'event_queued',
        sessionId: 'session_01',
        seq: 1,
        runId: 'run_01',
      ),
    );
    emitRunStarted(controller(), 'run_01', seq: 2);

    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        data: {
          'sessionId': 'session_01',
          'runId': 'run_01',
          'status': 'queued',
        },
      ),
    );
    await future;

    expect(state().queue, isEmpty);
    expect(state().activeRunId, 'run_01');
  });

  test('keeps the draft and reports SESSION_BUSY', () async {
    controller().updateDraft('hello');
    final future = controller().sendText();
    await pumpEventQueue();

    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        status: 'error',
        error: {
          'code': 'SESSION_BUSY',
          'message': 'busy',
          'retryable': true,
        },
      ),
    );
    await future;

    expect(state().draft, 'hello');
    expect(state().error, contains('已有任务'));
    expect(state().busy, isFalse);
  });

  test('keeps the same commandId when retrying after a timeout', () async {
    final timeoutSocket = FakeAgentSocket();
    final timeoutClient = CommandClient(timeoutSocket);
    final timeoutContainer = ProviderContainer(
      overrides: [
        commandClientProvider.overrideWith((ref) async => timeoutClient),
        promptTimeoutProvider.overrideWithValue(
          const Duration(milliseconds: 10),
        ),
      ],
    );
    addTearDown(() async {
      await timeoutClient.dispose();
      await timeoutSocket.close();
      timeoutContainer.dispose();
    });
    final chat = timeoutContainer.read(chatControllerProvider.notifier);
    chat.attachSession('session_01');
    chat.setConnection(ConnectionStatus.ready);
    chat.updateDraft('hello');

    await chat.sendText();
    final firstId = lastCommandId(timeoutSocket);
    expect(
      timeoutContainer.read(chatControllerProvider).composer,
      ComposerStatus.unknown,
    );

    final retry = chat.retryUnknownCommand();
    await pumpEventQueue();
    expect(lastCommandId(timeoutSocket), firstId);
    timeoutSocket.emitMessage(
      commandResult(commandId: firstId, data: {'sessionId': 'session_01', 'runId': 'run_01', 'status': 'queued'}),
    );
    await retry;
    emitRunStarted(chat, 'run_01');

    expect(timeoutContainer.read(chatControllerProvider).busy, isTrue);
  });

  test('clears busy state when run.completed arrives', () async {
    controller().updateDraft('hello');
    final future = controller().sendText();
    await pumpEventQueue();
    socket.emitMessage(
      commandResult(commandId: lastCommandId(socket), data: {'sessionId': 'session_01', 'runId': 'run_01', 'status': 'queued'}),
    );
    await future;
    emitRunStarted(controller(), 'run_01');
    expect(state().busy, isTrue);

    controller().mergeEvent(
      TimelineEvent(
        messageId: 'msg_1',
        timestamp: 1,
        type: 'run.completed',
        payload: const {'status': 'succeeded'},
        eventId: 'event_1',
        sessionId: 'session_01',
        seq: 2,
      ),
    );

    expect(state().busy, isFalse);
    expect(state().lastRunStatus?.name, 'succeeded');
  });

  test('cancels the active run with its runId', () async {
    controller().updateDraft('hello');
    final future = controller().sendText();
    await pumpEventQueue();
    socket.emitMessage(
      commandResult(commandId: lastCommandId(socket), data: {'sessionId': 'session_01', 'runId': 'run_01', 'status': 'queued'}),
    );
    await future;
    emitRunStarted(controller(), 'run_01');

    final cancel = controller().cancelActiveRun();
    await pumpEventQueue();

    expect(lastCommandType(socket), 'run.cancel');
    expect(jsonDecode(socket.sent.last), containsPair('runId', 'run_01'));
    expect(state().cancelling, isTrue);

    socket.emitMessage(commandResult(commandId: lastCommandId(socket)));
    await cancel;

    // 取消请求成功不代表 run 已终态，仍需等待 run.completed。
    expect(state().cancelling, isTrue);

    controller().mergeEvent(
      TimelineEvent(
        messageId: 'msg_2',
        timestamp: 2,
        type: 'run.completed',
        payload: {'status': 'cancelled'},
        eventId: 'event_2',
        sessionId: 'session_01',
        seq: 2,
      ),
    );

    expect(state().cancelling, isFalse);
    expect(state().busy, isFalse);
  });

  test('echoes and persists the user prompt', () async {
    final store = _MemoryUserMessages();
    controller().attachUserMessages(store);
    controller().updateDraft('你好');
    final future = controller().sendText();
    await pumpEventQueue();

    expect(state().userMessages.single.text, '你好');
    expect(store.rows.single.commandId, lastCommandId(socket));

    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        data: {
          'sessionId': 'session_01',
          'runId': 'run_01',
          'status': 'queued',
        },
      ),
    );
    await future;
  });

  test('restores user messages when reattaching a session', () async {
    final store = _MemoryUserMessages();
    await store.appendUserMessage(
      const UserMessage(
        sessionId: 'session_01',
        commandId: 'cmd_old',
        text: '旧问题',
        createdAt: 1,
      ),
    );
    controller().attachUserMessages(store);

    controller().attachSession('session_02');
    controller().attachSession('session_01');
    await pumpEventQueue();

    expect(state().userMessages.single.text, '旧问题');
  });

  test('restores user messages when the store attaches after the session', () async {
    final store = _MemoryUserMessages();
    await store.appendUserMessage(
      const UserMessage(
        sessionId: 'session_01',
        commandId: 'cmd_old',
        text: '旧问题',
        createdAt: 1,
      ),
    );

    // 会话先附着、本地存储后注入（会话列表 → 聊天页的真实顺序）。
    controller().attachUserMessages(store);
    await pumpEventQueue();

    expect(state().userMessages.single.text, '旧问题');
  });

  test('keeps user messages when re-entering the same session', () async {
    final store = _MemoryUserMessages();
    await store.appendUserMessage(
      const UserMessage(
        sessionId: 'session_01',
        commandId: 'cmd_old',
        text: '旧问题',
        createdAt: 1,
      ),
    );
    controller().attachUserMessages(store);
    await pumpEventQueue();

    controller().attachSession('session_01');
    await pumpEventQueue();

    expect(state().userMessages.single.text, '旧问题');
  });

  test('uploads a picked image and sends it with an empty draft', () async {
    final file = File(
      '${Directory.systemTemp.createTempSync('s06-pick-').path}/a.jpg',
    )..writeAsBytesSync(<int>[0xff, 0xd8, 0xff, 0xe0]);
    addTearDown(() => file.parent.deleteSync(recursive: true));
    controller().attachAttachmentUploader(
      (path) async => const UploadedAttachment(
        attachmentId: 'att_12345678',
        mediaType: 'image/jpeg',
        size: 4,
      ),
    );

    await controller().addImage(file.path);

    expect(state().attachments.single.isReady, isTrue);
    expect(state().canSend, isTrue);

    final future = controller().sendText();
    await pumpEventQueue();
    final payload =
        (jsonDecode(socket.sent.last) as Map<String, dynamic>)['payload']
            as Map<String, dynamic>;
    expect(payload['text'], '');
    expect(payload['attachments'], [
      {'attachmentId': 'att_12345678', 'mediaType': 'image/jpeg', 'size': 4},
    ]);
    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        data: {
          'sessionId': 'session_01',
          'runId': 'run_01',
          'status': 'queued',
        },
      ),
    );
    await future;

    expect(state().attachments, isEmpty);
    expect(state().userMessages.single.attachmentPaths, [file.path]);
  });

  test('drops a failed upload and keeps the draft unsendable', () async {
    final file = File(
      '${Directory.systemTemp.createTempSync('s06-pick-fail-').path}/a.jpg',
    )..writeAsBytesSync(<int>[0xff, 0xd8, 0xff, 0xe0]);
    addTearDown(() => file.parent.deleteSync(recursive: true));
    controller().attachAttachmentUploader(
      (path) async =>
          throw const AttachmentUploadException('UPLOAD_FAILED'),
    );

    await controller().addImage(file.path);

    expect(state().attachments, isEmpty);
    expect(state().error, contains('图片上传失败'));
  });

  test('removes a pending image', () async {
    final file = File(
      '${Directory.systemTemp.createTempSync('s06-pick-remove-').path}/a.jpg',
    )..writeAsBytesSync(<int>[0xff, 0xd8, 0xff, 0xe0]);
    addTearDown(() => file.parent.deleteSync(recursive: true));
    controller().attachAttachmentUploader(
      (path) async => const UploadedAttachment(
        attachmentId: 'att_12345678',
        mediaType: 'image/jpeg',
        size: 4,
      ),
    );
    await controller().addImage(file.path);

    controller().removeImage(file.path);

    expect(state().attachments, isEmpty);
  });
  test('attachSession seeds model and workspace from the summary', () {
    controller().attachSession(
      'session_02',
      workspaceId: 'ws_a',
      model: 'opus',
    );

    expect(state().model, 'opus');
    expect(state().workspaceId, 'ws_a');
  });

  test('session.status updates the model', () {
    controller().mergeEvent(
      TimelineEvent(
        messageId: 'msg_status_model',
        timestamp: 1,
        type: 'session.status',
        payload: const {'state': 'idle', 'model': 'sonnet'},
        eventId: 'event_status_model',
        sessionId: 'session_01',
        seq: 1,
      ),
    );

    expect(state().model, 'sonnet');
  });

  test('session.status clears or keeps the model per payload', () {
    controller().attachSession('session_02', model: 'opus');

    // 缺失 model 字段 → 保留本地值。
    controller().mergeEvent(
      TimelineEvent(
        messageId: 'msg_status_keep',
        timestamp: 1,
        type: 'session.status',
        payload: const {'state': 'idle'},
        eventId: 'event_status_keep',
        sessionId: 'session_02',
        seq: 1,
      ),
    );
    expect(state().model, 'opus');

    // 显式 null → 清空，回到跟随 Mac 默认。
    controller().mergeEvent(
      TimelineEvent(
        messageId: 'msg_status_clear',
        timestamp: 2,
        type: 'session.status',
        payload: const {'state': 'idle', 'model': null},
        eventId: 'event_status_clear',
        sessionId: 'session_02',
        seq: 2,
      ),
    );
    expect(state().model, isNull);
  });

  test('mergeSnapshot updates the workspace id', () {
    controller().attachSession('session_02');
    expect(state().workspaceId, isNull);

    controller().mergeSnapshot(
      SessionSnapshot(
        sessionId: null,
        events: const <TimelineEvent>[],
        lastSeq: 1,
        workspaceId: 'ws_b',
      ),
    );
    expect(state().workspaceId, 'ws_b');

    // 快照缺 workspaceId → 保留本地值。
    controller().mergeSnapshot(
      SessionSnapshot(
        sessionId: null,
        events: const <TimelineEvent>[],
        lastSeq: 2,
      ),
    );
    expect(state().workspaceId, 'ws_b');
  });

  test('setSessionModel sends session.set-model and adopts the returned summary', () async {
    final future = controller().setSessionModel('opus');
    await pumpEventQueue();

    expect(lastCommandType(socket), 'session.set-model');
    final payload =
        (jsonDecode(socket.sent.last) as Map<String, dynamic>)['payload']
            as Map<String, dynamic>;
    expect(payload['model'], 'opus');

    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        data: {'sessionId': 'session_01', 'model': 'opus'},
      ),
    );
    await future;

    expect(state().model, 'opus');
    expect(state().error, isNull);
  });

  test('setSessionModel(null) clears back to the Mac default', () async {
    final future = controller().setSessionModel(null);
    await pumpEventQueue();

    final payload =
        (jsonDecode(socket.sent.last) as Map<String, dynamic>)['payload']
            as Map<String, dynamic>;
    expect(payload['model'], isNull);

    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        data: {'sessionId': 'session_01'},
      ),
    );
    await future;

    expect(state().model, isNull);
    expect(state().error, isNull);
  });

  test('setSessionModel surfaces UNKNOWN_MESSAGE_TYPE', () async {
    final future = controller().setSessionModel('opus');
    await pumpEventQueue();

    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        status: 'error',
        error: {
          'code': 'UNKNOWN_MESSAGE_TYPE',
          'message': 'unknown',
          'retryable': false,
        },
      ),
    );
    await future;

    expect(state().error, contains('升级'));
  });

  test('ignores a late model result after switching sessions', () async {
    final future = controller().setSessionModel('opus');
    await pumpEventQueue();

    expect(lastCommandType(socket), 'session.set-model');
    final commandId = lastCommandId(socket);

    // 命令在途时切到另一个会话；旧会话的结果不得覆盖新会话。
    controller().attachSession('session_02', model: 'sonnet');

    socket.emitMessage(
      commandResult(
        commandId: commandId,
        data: {'sessionId': 'session_01', 'model': 'opus'},
      ),
    );
    await future;

    expect(state().model, 'sonnet');
    expect(state().error, isNull);
  });

  test('resetForDeviceSwitch clears the attached session and drafts', () {
    controller().updateDraft('draft');
    expect(controller().sessionId, 'session_01');
    expect(state().draft, 'draft');

    controller().resetForDeviceSwitch();

    expect(controller().sessionId, isNull);
    expect(state().draft, isEmpty);
  });
}

final class _MemoryUserMessages implements UserMessageStore {
  final List<UserMessage> rows = <UserMessage>[];

  @override
  Future<void> appendUserMessage(UserMessage message) async {
    rows.add(message);
  }

  @override
  Future<List<UserMessage>> readUserMessages(String sessionId) async {
    return rows
        .where((message) => message.sessionId == sessionId)
        .toList(growable: false);
  }
}