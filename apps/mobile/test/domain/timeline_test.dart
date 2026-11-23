import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/domain/timeline.dart';
import 'package:claude_remote/protocol/envelope.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter_test/flutter_test.dart';

const sessionId = 'session_01';

TimelineEvent event({
  required int seq,
  required String type,
  required Map<String, Object?> payload,
  String? eventId,
  String eventSessionId = sessionId,
  String? runId,
}) {
  return TimelineEvent(
    messageId: 'msg_$seq',
    timestamp: 1762432800000 + seq,
    type: type,
    payload: payload,
    eventId: eventId ?? 'event_$seq',
    sessionId: eventSessionId,
    seq: seq,
    runId: runId,
  );
}

Map<String, Object?> wireEvent({
  required int seq,
  required String type,
  required Map<String, Object?> payload,
}) {
  return {
    'protocolVersion': 1,
    'messageId': 'msg_$seq',
    'timestamp': 1762432800000 + seq,
    'type': type,
    'eventId': 'event_$seq',
    'sessionId': sessionId,
    'seq': seq,
    'payload': payload,
  };
}

void main() {
  test('merges deltas and lets completed replace the text', () {
    var state = TimelineState.initial(sessionId);
    state = applyEvent(
      state,
      event(
        seq: 1,
        type: 'message.delta',
        payload: {'assistantMessageId': 'm1', 'text': '检查'},
      ),
    );
    state = applyEvent(
      state,
      event(
        seq: 2,
        type: 'message.delta',
        payload: {'assistantMessageId': 'm1', 'text': '完成'},
      ),
    );
    expect(state.messages.single.text, '检查完成');

    final next = applyEvent(
      state,
      event(
        seq: 3,
        type: 'message.completed',
        payload: {'assistantMessageId': 'm1', 'text': '检查完成!'},
      ),
    );

    expect(next.messages, hasLength(1));
    expect(next.messages.single.text, '检查完成!');
    expect(next.messages.single.completed, isTrue);
  });

  test('keeps accumulated text when completed is truncated', () {
    final longText = 'a' * 120;
    var state = applyEvent(
      TimelineState.initial(sessionId),
      event(
        seq: 1,
        type: 'message.delta',
        payload: {'assistantMessageId': 'm1', 'text': longText},
      ),
    );

    state = applyEvent(
      state,
      event(
        seq: 2,
        type: 'message.completed',
        payload: {
          'assistantMessageId': 'm1',
          'text': '',
          'contentTruncated': true,
        },
      ),
    );

    expect(state.messages.single.text, longText);
    expect(state.messages.single.contentTruncated, isTrue);
  });

  test('updates one tool card by toolUseId', () {
    var state = TimelineState.initial(sessionId);
    state = applyEvent(
      state,
      event(
        seq: 1,
        type: 'tool.started',
        payload: {
          'toolUseId': 'toolu_01',
          'toolName': 'Bash',
          'input': {'command': 'pwd'},
        },
      ),
    );
    state = applyEvent(
      state,
      event(
        seq: 2,
        type: 'tool.output',
        payload: {'toolUseId': 'toolu_01', 'chunk': '/tmp', 'truncated': false},
      ),
    );
    state = applyEvent(
      state,
      event(
        seq: 3,
        type: 'tool.completed',
        payload: {'toolUseId': 'toolu_01', 'status': 'succeeded'},
      ),
    );

    expect(state.tools, hasLength(1));
    expect(state.tools.single.output, '/tmp');
    expect(state.tools.single.status, 'succeeded');
  });

  test('ignores a retransmitted eventId with identical content', () {
    final first = event(
      seq: 1,
      type: 'message.delta',
      payload: {'assistantMessageId': 'm1', 'text': 'a'},
    );
    final state = applyEvent(TimelineState.initial(sessionId), first);

    final next = applyEvent(state, first);

    expect(next.lastSeq, 1);
    expect(next.messages.single.text, 'a');
    expect(identical(next, state), isTrue);
  });

  test('rejects an eventId retransmitted with different content', () {
    final state = applyEvent(
      TimelineState.initial(sessionId),
      event(
        seq: 1,
        type: 'message.delta',
        payload: {'assistantMessageId': 'm1', 'text': 'a'},
      ),
    );

    expect(
      () => applyEvent(
        state,
        event(
          seq: 1,
          type: 'message.delta',
          payload: {'assistantMessageId': 'm1', 'text': 'b'},
        ),
      ),
      throwsA(isA<ProtocolConflictException>()),
    );
  });

  test('rejects events from another session', () {
    expect(
      () => applyEvent(
        TimelineState.initial(sessionId),
        event(
          seq: 1,
          type: 'message.delta',
          eventSessionId: 'session_02',
          payload: {'assistantMessageId': 'm1', 'text': 'a'},
        ),
      ),
      throwsA(isA<ProtocolConflictException>()),
    );
  });

  test('rejects an unseen event whose seq is already behind', () {
    final state = applyEvent(
      TimelineState.initial(sessionId),
      event(
        seq: 5,
        type: 'message.delta',
        payload: {'assistantMessageId': 'm1', 'text': 'a'},
      ),
    );

    expect(
      () => applyEvent(
        state,
        event(
          seq: 3,
          type: 'message.delta',
          payload: {'assistantMessageId': 'm1', 'text': 'b'},
        ),
      ),
      throwsA(isA<ProtocolConflictException>()),
    );
  });

  test('snapshot clears volatile state and marks truncation', () {
    var state = applyEvent(
      TimelineState.initial(sessionId),
      event(
        seq: 1,
        type: 'message.delta',
        payload: {'assistantMessageId': 'm1', 'text': 'old'},
      ),
    );

    final snapshot = SessionSnapshot.fromPayload({
      'session': {
        'sessionId': sessionId,
        'claudeSessionId': 'claude_01',
        'workspaceId': 'default',
        'status': 'running',
      },
      'activeRun': {
        'runId': 'run_02',
        'status': 'running',
        'commandId': 'cmd_02',
      },
      'recentEvents': [
        wireEvent(
          seq: 8,
          type: 'message.delta',
          payload: {'assistantMessageId': 'm2', 'text': 'new'},
        ),
      ],
      'lastSeq': 10,
      'oldestIncludedSeq': 8,
      'snapshotTruncated': true,
    });

    state = applySnapshot(state, snapshot);

    expect(state.messages.map((message) => message.assistantMessageId), ['m2']);
    expect(state.lastSeq, 10);
    expect(state.oldestIncludedSeq, 8);
    expect(state.snapshotTruncated, isTrue);
    expect(state.activeRunId, 'run_02');
    expect(state.claudeSessionId, 'claude_01');
    expect(state.sessionStatus, 'running');
  });

  test('snapshot preview does not overwrite longer local text', () {
    final longText = 'x' * 200;
    final state = applyEvent(
      TimelineState.initial(sessionId),
      event(
        seq: 1,
        type: 'message.delta',
        payload: {'assistantMessageId': 'm1', 'text': longText},
      ),
    );

    final snapshot = SessionSnapshot.fromPayload({
      'recentEvents': [
        wireEvent(
          seq: 2,
          type: 'message.completed',
          payload: {
            'assistantMessageId': 'm1',
            'text': 'short',
            'contentTruncated': true,
          },
        ),
      ],
      'lastSeq': 5,
      'snapshotTruncated': true,
    });

    final next = applySnapshot(state, snapshot);

    expect(next.messages.single.text, longText);
  });

  test('keeps the tool start timestamp across output and completion', () {
    var state = applyEvent(
      TimelineState.initial(sessionId),
      event(
        seq: 1,
        type: 'tool.started',
        payload: {
          'toolUseId': 'toolu_01',
          'toolName': 'Bash',
          'input': {'command': 'pwd'},
        },
      ),
    );
    final startedAt = state.tools.single.createdAt;
    expect(startedAt, greaterThan(0));

    state = applyEvent(
      state,
      event(
        seq: 2,
        type: 'tool.output',
        payload: {'toolUseId': 'toolu_01', 'chunk': '/tmp'},
      ),
    );
    state = applyEvent(
      state,
      event(
        seq: 3,
        type: 'tool.completed',
        payload: {'toolUseId': 'toolu_01', 'status': 'succeeded'},
      ),
    );

    expect(state.tools.single.createdAt, startedAt);
  });

  test('reducers never mutate the previous state', () {
    final previous = TimelineState.initial(sessionId);
    final next = applyEvent(
      previous,
      event(
        seq: 1,
        type: 'message.delta',
        payload: {'assistantMessageId': 'm1', 'text': 'a'},
      ),
    );

    expect(previous.lastSeq, 0);
    expect(previous.messages, isEmpty);
    expect(next.messages, hasLength(1));
  });
}