import 'dart:async';
import 'dart:convert';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/connection_controller.dart';
import 'package:claude_remote/connection/session_sync_controller.dart';
import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/features/chat/prompt_command_coordinator.dart';
import 'package:claude_remote/protocol/s02_messages.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_socket.dart';

String typeOf(String raw) => (jsonDecode(raw) as Map)['type'] as String;
String commandIdOf(String raw) => (jsonDecode(raw) as Map)['commandId'] as String;
String sessionIdOf(String raw) =>
    (jsonDecode(raw) as Map)['sessionId'] as String? ?? '';

void main() {
  test('parses agentInstanceId and reports only real changes', () async {
    final factory = FakeSocketFactory();
    final changes = <String>[];
    var readyCalls = 0;
    final controller = ConnectionController(
      socketFactory: factory.call,
      deviceId: 'device_01',
      appVersion: '1.0.0',
      onReady: () async {
        readyCalls += 1;
      },
      onAgentInstanceChanged: (previous, next) => changes.add(next),
      delay: (_) async {},
      jitter: () => Duration.zero,
    );

    final first = controller.connect();
    await pumpEventQueue();
    factory.sockets.single.emitMessage(
      readyMessage(agentInstanceId: 'agent_1'),
    );
    await first;

    expect(controller.agentInstanceId, 'agent_1');
    expect(changes, <String>['agent_1']);
    expect(readyCalls, 1);

    await controller.dispose();
  });

  test('a new agent instance invalidates scheduled prompt retries', () async {
    final socket = FakeAgentSocket();
    final client = CommandClient(socket);
    final coordinator = PromptCommandCoordinator(client: client);
    final controller = ConnectionController(
      socketFactory: () => socket,
      deviceId: 'device_01',
      appVersion: '1.0.0',
      onReady: () async {},
      onAgentInstanceChanged: (previous, next) {
        if (previous != null && previous != next) {
          coordinator.invalidateForRestart();
        }
      },
      delay: (_) async {},
      jitter: () => Duration.zero,
    );

    final connecting = controller.connect();
    await pumpEventQueue();
    socket.emitMessage(readyMessage(agentInstanceId: 'agent_1'));
    await connecting;

    unawaited(
      coordinator.send(
        S02Commands.promptSend(
          commandId: 'cmd_first',
          traceId: 'trace_first',
          sessionId: 'session_a',
          text: 'first',
        ),
      ).catchError(
        (Object _) => const PromptAccepted(
          sessionId: 'session_a',
          runId: 'run_x',
          status: 'queued',
        ),
      ),
    );
    await pumpEventQueue();
    expect(coordinator.canSend('session_a'), isFalse);

    coordinator.invalidateForRestart();
    expect(coordinator.unknownFor('session_a')?.reason, 'agent-restarted');

    await controller.dispose();
    await client.dispose();
  });

  test('refreshes the current session before other active sessions', () async {
    final socket = FakeAgentSocket();
    final client = CommandClient(socket);
    final applied = <String>[];
    var sequence = 0;
    final sync = SessionSyncController(
      client: client,
      currentSessionId: () => 'session_a',
      activeSessionIds: () => <String>['session_a', 'session_b', 'session_c'],
      newId: (prefix) => '${prefix}_${++sequence}',
      onSnapshot: (snapshot) =>
          applied.add(snapshot.sessionId ?? 'unknown'),
    );

    final refreshing = sync.refreshCurrentAndActive();
    await pumpEventQueue();

    final snapshotFrames = socket.sent.where(
      (raw) => typeOf(raw) == 'session.snapshot',
    );
    expect(
      snapshotFrames.map(sessionIdOf).toList(),
      <String>['session_a', 'session_b', 'session_c'],
    );

    for (final raw in snapshotFrames) {
      socket.emitMessage(
        commandResult(
          commandId: commandIdOf(raw),
          data: {
            'snapshot': {
              'session': {
                'sessionId': sessionIdOf(raw),
                'status': 'idle',
              },
              'lastSeq': 0,
              'recentEvents': <Object?>[],
            },
          },
        ),
      );
    }
    await refreshing;

    expect(applied, <String>['session_a', 'session_b', 'session_c']);
    await client.dispose();
  });

  test('refreshSnapshot only touches its target session', () async {
    final socket = FakeAgentSocket();
    final client = CommandClient(socket);
    final applied = <SessionSnapshot>[];
    final sync = SessionSyncController(
      client: client,
      currentSessionId: () => 'session_a',
      activeSessionIds: () => <String>[],
      newId: (prefix) => '${prefix}_1',
      onSnapshot: applied.add,
    );

    final refreshing = sync.refreshSnapshot('session_b');
    await pumpEventQueue();
    final frame = socket.sent.single;
    expect(sessionIdOf(frame), 'session_b');

    socket.emitMessage(
      commandResult(
        commandId: commandIdOf(frame),
        data: {
          'snapshot': {
            'session': {'sessionId': 'session_b', 'status': 'idle'},
            'lastSeq': 2,
            'recentEvents': <Object?>[],
          },
        },
      ),
    );
    await refreshing;

    expect(applied.single.sessionId, 'session_b');
    await client.dispose();
  });
}