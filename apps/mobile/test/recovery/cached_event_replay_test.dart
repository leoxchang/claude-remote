import 'dart:convert';

import 'package:claude_remote/recovery/cache_repository.dart';
import 'package:claude_remote/recovery/cached_event_replay.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> legacyPayload({String type = 'message.completed'}) {
  // 旧版落库的 envelope 只有这四类字段，不含 eventId/sessionId/seq。
  return {
    'protocolVersion': 1,
    'messageId': 'msg_event_1',
    'timestamp': 1762432800000,
    'type': type,
    'payload': const {'assistantMessageId': 'msg_a', 'text': 'hi'},
  };
}

CachedEvent cachedEvent({
  required Map<String, Object?> payload,
  String eventId = 'event_1',
  String sessionId = 'session_01',
  int seq = 1,
}) {
  return CachedEvent(
    eventId: eventId,
    sessionId: sessionId,
    seq: seq,
    payloadJson: jsonEncode(payload),
    cachedAt: 1,
  );
}

void main() {
  test('旧版缓存缺事件身份字段时用行内字段补全后回放', () {
    final decoded = decodeCachedEvents([
      cachedEvent(payload: legacyPayload()),
    ]);

    expect(decoded, isNotNull);
    expect(decoded, hasLength(1));
    final event = decoded!.single;
    expect(event.eventId, 'event_1');
    expect(event.sessionId, 'session_01');
    expect(event.seq, 1);
    expect(event.type, 'message.completed');
    expect(event.payload['text'], 'hi');
  });

  test('缓存行内容损坏时返回 null，调用方应清空缓存', () {
    final decoded = decodeCachedEvents([
      CachedEvent(
        eventId: 'event_1',
        sessionId: 'session_01',
        seq: 1,
        payloadJson: '{"broken"',
        cachedAt: 1,
      ),
    ]);

    expect(decoded, isNull);
  });

  test('载荷里的身份字段与缓存行冲突时返回 null', () {
    final conflicting = legacyPayload()..['eventId'] = 'event_other';

    final decoded = decodeCachedEvents([
      cachedEvent(payload: conflicting),
    ]);

    expect(decoded, isNull);
  });

  test('未知 permission 事件引发的协议冲突按缓存损坏处理', () {
    final decoded = decodeCachedEvents([
      cachedEvent(payload: legacyPayload(type: 'permission.unknown')),
    ]);

    expect(decoded, isNull);
  });
}
