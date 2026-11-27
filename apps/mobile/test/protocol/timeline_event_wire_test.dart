import 'dart:convert';

import 'package:claude_remote/protocol/decoder.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('TimelineEvent.toWire 保留事件身份字段，可被解码器回放', () {
    final event = TimelineEvent(
      messageId: 'msg_1',
      timestamp: 1762432800000,
      type: 'message.completed',
      payload: const {'assistantMessageId': 'msg_a', 'text': 'hi'},
      eventId: 'event_1',
      sessionId: 'session_01',
      seq: 3,
      runId: 'run_01',
    );

    final decoded = ProtocolDecoder.decode(jsonEncode(event.toWire()));

    expect(decoded, isA<TimelineEvent>());
    final replayed = decoded as TimelineEvent;
    expect(replayed.eventId, 'event_1');
    expect(replayed.sessionId, 'session_01');
    expect(replayed.seq, 3);
    expect(replayed.runId, 'run_01');
    expect(replayed.type, 'message.completed');
    expect(replayed.payload['text'], 'hi');
  });
}
