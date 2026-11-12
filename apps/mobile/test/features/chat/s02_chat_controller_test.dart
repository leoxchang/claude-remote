import 'dart:convert';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/connection_controller.dart';
import 'package:claude_remote/data/providers.dart';
import 'package:claude_remote/domain/run.dart';
import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/features/chat/chat_controller.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../connection/fake_socket.dart';

String lastCommandId(FakeAgentSocket socket) =>
    (jsonDecode(socket.sent.last) as Map)['commandId'] as String;

String lastCommandType(FakeAgentSocket socket) =>
    (jsonDecode(socket.sent.last) as Map)['type'] as String;

TimelineEvent event({
  required int seq,
  required String type,
  String? runId,
  Map<String, Object?> payload = const <String, Object?>{},
}) {
  return TimelineEvent(
    messageId: 'msg_$seq',
    timestamp: 1,
    type: type,
    payload: payload,
    eventId: 'event_$seq',
    sessionId: 'session_01',
    seq: seq,
    runId: runId,
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

  test('sends while a run is active and records the queued run', () async {
    controller().mergeEvent(
      event(
        seq: 1,
        type: 'session.status',
        payload: {'state': 'running', 'activeRunId': 'run_active'},
      ),
    );
    expect(state().queueMode, isTrue);

    controller().updateDraft('next task');
    final future = controller().sendText();
    await pumpEventQueue();

    expect(lastCommandType(socket), 'prompt.send');
    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        data: {'sessionId': 'session_01', 'runId': 'run_q1', 'status': 'queued'},
      ),
    );
    await future;

    expect(state().queue.single.runId, 'run_q1');
    expect(state().queuePreviews['run_q1'], 'next task');
    expect(state().activeRunId, 'run_active');
    expect(state().error, isNull);
  });

  test('maps QUEUE_FULL and keeps the draft', () async {
    controller().updateDraft('hello');
    final future = controller().sendText();
    await pumpEventQueue();
    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        status: 'error',
        error: {'code': 'QUEUE_FULL', 'message': 'QUEUE_FULL'},
      ),
    );
    await future;

    expect(state().draft, 'hello');
    expect(state().error, contains('队列已满'));
    expect(state().queue, isEmpty);
  });

  test('archived sessions cannot send', () async {
    controller().mergeEvent(
      event(seq: 1, type: 'session.status', payload: {'state': 'archived'}),
    );
    controller().updateDraft('hello');

    await controller().sendText();

    expect(socket.sent, isEmpty);
    expect(state().error, contains('已归档'));
    expect(state().canSend, isFalse);
  });

  test('removes only the targeted queued run', () async {
    controller().mergeEvent(
      event(seq: 1, type: 'run.queued', runId: 'run_q1', payload: {'enqueuedAt': 1}),
    );
    controller().mergeEvent(
      event(seq: 2, type: 'run.queued', runId: 'run_q2', payload: {'enqueuedAt': 2}),
    );

    final removing = controller().removeQueuedRun('run_q1');
    await pumpEventQueue();

    expect(lastCommandType(socket), 'queue.remove');
    expect(jsonDecode(socket.sent.last), containsPair('runId', 'run_q1'));
    socket.emitMessage(
      commandResult(
        commandId: lastCommandId(socket),
        data: {
          'sessionId': 'session_01',
          'runId': 'run_q1',
          'status': 'cancelled',
          'removed': true,
        },
      ),
    );
    await removing;

    expect(state().queue.single.runId, 'run_q2');
  });

  test('run events move work between queue and active run', () async {
    controller().mergeEvent(
      event(seq: 1, type: 'run.queued', runId: 'run_q1', payload: {'enqueuedAt': 1}),
    );
    controller().mergeEvent(
      event(seq: 2, type: 'run.started', runId: 'run_q1', payload: {'status': 'starting'}),
    );
    expect(state().queue, isEmpty);
    expect(state().activeRunId, 'run_q1');

    controller().mergeEvent(
      event(seq: 3, type: 'run.completed', runId: 'run_q1', payload: {'status': 'succeeded'}),
    );
    expect(state().activeRunId, isNull);
    expect(state().lastRunStatus, RunStatus.succeeded);
  });

  test('snapshot replaces queue and global capacity', () async {
    controller().mergeEvent(
      event(seq: 1, type: 'run.queued', runId: 'run_old', payload: {'enqueuedAt': 1}),
    );

    controller().mergeSnapshot(
      SessionSnapshot(
        sessionId: null,
        events: const <TimelineEvent>[],
        lastSeq: 4,
        queuedRuns: const <QueuedRunSummary>[
          QueuedRunSummary(runId: 'run_new', commandId: 'cmd_new', enqueuedAt: 4),
        ],
        globalCapacity: const GlobalCapacity(activeRunCount: 2, maxActiveRuns: 2),
      ),
    );

    expect(state().queue.single.runId, 'run_new');
    expect(state().slotsFull, isTrue);
    expect(state().queueMode, isTrue);
  });

  test('agent restart invalidates an unresolved prompt', () async {
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
    expect(
      timeoutContainer.read(chatControllerProvider).composer,
      ComposerStatus.unknown,
    );

    chat.invalidateForRestart();

    final state = timeoutContainer.read(chatControllerProvider);
    expect(state.composer, ComposerStatus.unknown);
    expect(state.error, contains('Agent 已重启'));
    expect(timeoutSocket.sent, hasLength(1));
  });
}