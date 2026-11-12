import 'dart:async';
import 'dart:convert';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/features/chat/prompt_command_coordinator.dart';
import 'package:claude_remote/protocol/s02_messages.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../connection/fake_socket.dart';

CommandRequest<PromptAccepted> request(
  String sessionId,
  String text, {
  String? commandId,
}) {
  return S02Commands.promptSend(
    commandId: commandId ?? 'cmd_$text',
    traceId: 'trace_$text',
    sessionId: sessionId,
    text: text,
  );
}

List<Map<String, Object?>> sentFrames(FakeAgentSocket socket) {
  return socket.sent
      .map((raw) => (jsonDecode(raw) as Map).cast<String, Object?>())
      .toList(growable: false);
}

List<String> sentTexts(FakeAgentSocket socket) {
  return sentFrames(socket)
      .map((frame) => (frame['payload'] as Map)['text'] as String)
      .toList(growable: false);
}

List<String> sentSessionIds(FakeAgentSocket socket) {
  return sentFrames(socket)
      .map((frame) => frame['sessionId'] as String? ?? '')
      .toList(growable: false);
}

void main() {
  late FakeAgentSocket socket;

  PromptCommandCoordinator build() {
    socket = FakeAgentSocket();
    return PromptCommandCoordinator(client: CommandClient(socket));
  }

  test('second prompt cannot overtake an unresolved first prompt in one session', () {
    fakeAsync((clock) {
      final coordinator = build();
      unawaited(
        coordinator.send(request('a', 'first')).catchError(
              (Object _) => const PromptAccepted(
                sessionId: 'a',
                runId: 'run_x',
                status: 'queued',
              ),
            ),
      );
      clock.flushMicrotasks();

      expect(coordinator.canSend('a'), isFalse);
      expect(coordinator.canSend('b'), isTrue);
      expect(
        () => coordinator.send(request('a', 'second')),
        throwsA(isA<CommandFailure>()),
      );

      clock.elapse(const Duration(seconds: 11));
      expect(coordinator.unknownFor('a'), isNotNull);
      expect(coordinator.canSend('a'), isFalse);

      unawaited(
        coordinator.retry('a').catchError(
              (Object _) => const PromptAccepted(
                sessionId: 'a',
                runId: 'run_x',
                status: 'queued',
              ),
            ),
      );
      clock.flushMicrotasks();

      expect(sentTexts(socket), <String>['first', 'first']);
      expect(sentFrames(socket).map((frame) => frame['commandId']).toSet(), {
        'cmd_first',
      });
    });
  });

  test('keeps per-session targets while the user switches sessions', () {
    fakeAsync((clock) {
      final coordinator = build();
      unawaited(
        coordinator.send(request('a', 'alpha')).catchError(
              (Object _) => const PromptAccepted(
                sessionId: 'a',
                runId: 'run_x',
                status: 'queued',
              ),
            ),
      );
      clock.flushMicrotasks();

      // 用户切到 b 并发送；两条命令各自属于原会话。
      unawaited(
        coordinator.send(request('b', 'beta')).catchError(
              (Object _) => const PromptAccepted(
                sessionId: 'b',
                runId: 'run_y',
                status: 'queued',
              ),
            ),
      );
      clock.flushMicrotasks();

      expect(sentSessionIds(socket), <String>['a', 'b']);
    });
  });

  test('instance change prevents an already scheduled retry callback', () {
    fakeAsync((clock) {
      final coordinator = build();
      unawaited(
        coordinator.send(request('a', 'first')).catchError(
              (Object _) => const PromptAccepted(
                sessionId: 'a',
                runId: 'run_x',
                status: 'queued',
              ),
            ),
      );
      clock.flushMicrotasks();
      clock.elapse(const Duration(seconds: 11));
      expect(sentFrames(socket), hasLength(1));

      coordinator.invalidateForRestart();
      clock.elapse(const Duration(seconds: 30));

      expect(sentFrames(socket), hasLength(1));
      final unknown = coordinator.unknownFor('a');
      expect(unknown, isNotNull);
      expect(unknown!.reason, 'agent-restarted');
      expect(unknown.request.commandId, 'cmd_first');
      expect(coordinator.canSend('a'), isFalse);
    });
  });

  test('discardUnknown allows a new prompt in the same session', () {
    fakeAsync((clock) {
      final coordinator = build();
      unawaited(
        coordinator.send(request('a', 'first')).catchError(
              (Object _) => const PromptAccepted(
                sessionId: 'a',
                runId: 'run_x',
                status: 'queued',
              ),
            ),
      );
      clock.flushMicrotasks();
      clock.elapse(const Duration(seconds: 11));

      coordinator.invalidateForRestart();
      coordinator.discardUnknown('a');

      expect(coordinator.unknownFor('a'), isNull);
      expect(coordinator.canSend('a'), isTrue);
    });
  });

  test('same-instance reconnect keeps the original command id for retry', () {
    fakeAsync((clock) {
      final coordinator = build();
      unawaited(
        coordinator.send(request('a', 'first')).catchError(
              (Object _) => const PromptAccepted(
                sessionId: 'a',
                runId: 'run_x',
                status: 'queued',
              ),
            ),
      );
      clock.flushMicrotasks();
      clock.elapse(const Duration(seconds: 11));

      unawaited(
        coordinator.retry('a').catchError(
              (Object _) => const PromptAccepted(
                sessionId: 'a',
                runId: 'run_x',
                status: 'queued',
              ),
            ),
      );
      clock.flushMicrotasks();

      expect(
        sentFrames(socket).map((frame) => frame['commandId']).toList(),
        <String>['cmd_first', 'cmd_first'],
      );
      expect(
        sentFrames(socket).map((frame) => frame['messageId']).toSet().length,
        2,
      );
    });
  });
}