import 'dart:convert';

import '../protocol/decoder.dart';
import '../protocol/envelope.dart';
import '../protocol/messages.dart';
import 'cache_repository.dart';

/// 解码本地缓存用于冷启动回放。
///
/// v4 时代的缓存用只含信封字段的 JSON 落库，eventId/sessionId/seq 只能从
/// 缓存行的列里补回；任一条仍无法解码时返回 null，调用方应清空缓存，
/// 不能静默跳过后继续展示残缺历史。
List<TimelineEvent>? decodeCachedEvents(List<CachedEvent> cached) {
  final events = <TimelineEvent>[];
  for (final entry in cached) {
    final event = _decodeCachedEvent(entry);
    if (event == null) return null;
    events.add(event);
  }
  return events;
}

TimelineEvent? _decodeCachedEvent(CachedEvent entry) {
  final Object? root;
  try {
    root = jsonDecode(entry.payloadJson);
  } on FormatException {
    return null;
  }
  if (root is! Map<String, Object?>) return null;
  if (!_agrees(root, 'eventId', entry.eventId) ||
      !_agrees(root, 'sessionId', entry.sessionId) ||
      !_agrees(root, 'seq', entry.seq)) {
    return null;
  }
  final wire = <String, Object?>{
    ...root,
    'eventId': entry.eventId,
    'sessionId': entry.sessionId,
    'seq': entry.seq,
  };
  try {
    final message = ProtocolDecoder.decode(jsonEncode(wire));
    return message is TimelineEvent ? message : null;
  } on ProtocolDecodeException {
    return null;
  } on ProtocolConflictException {
    // 未知 permission 类型等冲突同样说明这行缓存不可信。
    return null;
  } on FormatException {
    return null;
  }
}

/// 载荷里已有同名字段时必须与缓存行一致，缺字段则按行补全。
bool _agrees(Map<String, Object?> root, String key, Object expected) {
  final value = root[key];
  return value == null || value == expected;
}
