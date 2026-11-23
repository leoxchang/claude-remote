import 'dart:convert';

import '../protocol/envelope.dart';
import '../protocol/messages.dart';
import 'run.dart';
import 'session.dart';

/// 助手消息时间线项。
final class TimelineMessage {
  const TimelineMessage({
    required this.assistantMessageId,
    required this.text,
    this.completed = false,
    this.contentTruncated = false,
    this.createdAt = 0,
  });

  final String assistantMessageId;
  final String text;
  final bool completed;
  final bool contentTruncated;

  /// 首条事件的时间戳；与本地提问合并排序使用。
  final int createdAt;

  TimelineMessage copyWith({
    String? text,
    bool? completed,
    bool? contentTruncated,
    int? createdAt,
  }) {
    return TimelineMessage(
      assistantMessageId: assistantMessageId,
      text: text ?? this.text,
      completed: completed ?? this.completed,
      contentTruncated: contentTruncated ?? this.contentTruncated,
      createdAt: createdAt ?? this.createdAt,
    );
  }
}

/// 按 toolUseId 归并的工具卡片。
final class TimelineTool {
  const TimelineTool({
    required this.toolUseId,
    required this.toolName,
    this.input = const <String, Object?>{},
    this.output = '',
    this.status,
    this.isError = false,
    this.summary,
    this.outputTruncated = false,
    this.createdAt = 0,
  });

  final String toolUseId;
  final String toolName;
  final Map<String, Object?> input;
  final String output;
  final String? status;
  final bool isError;
  final String? summary;
  final bool outputTruncated;

  /// 工具开始时间；与助手消息合并排序，还原 Claude Code 的执行顺序。
  final int createdAt;

  TimelineTool copyWith({
    String? output,
    String? status,
    bool? isError,
    String? summary,
    bool? outputTruncated,
    int? createdAt,
  }) {
    return TimelineTool(
      toolUseId: toolUseId,
      toolName: toolName,
      input: input,
      output: output ?? this.output,
      status: status ?? this.status,
      isError: isError ?? this.isError,
      summary: summary ?? this.summary,
      outputTruncated: outputTruncated ?? this.outputTruncated,
      createdAt: createdAt ?? this.createdAt,
    );
  }
}

/// 不可变时间线状态；所有 reducer 都返回新实例。
final class TimelineState {
  const TimelineState({
    required this.sessionId,
    this.lastSeq = 0,
    this.oldestIncludedSeq,
    this.messages = const <TimelineMessage>[],
    this.tools = const <TimelineTool>[],
    this.lastRunStatus,
    this.sessionStatus,
    this.activeRunId,
    this.claudeSessionId,
    this.snapshotTruncated = false,
    this.seenEvents = const <String, String>{},
  });

  factory TimelineState.initial(String sessionId) =>
      TimelineState(sessionId: sessionId);

  final String sessionId;
  final int lastSeq;
  final int? oldestIncludedSeq;
  final List<TimelineMessage> messages;
  final List<TimelineTool> tools;
  final RunStatus? lastRunStatus;
  final String? sessionStatus;
  final String? activeRunId;
  final String? claudeSessionId;
  final bool snapshotTruncated;
  final Map<String, String> seenEvents;

  TimelineState copyWith({
    int? lastSeq,
    int? oldestIncludedSeq,
    List<TimelineMessage>? messages,
    List<TimelineTool>? tools,
    RunStatus? lastRunStatus,
    String? sessionStatus,
    String? activeRunId,
    String? claudeSessionId,
    bool? snapshotTruncated,
    Map<String, String>? seenEvents,
  }) {
    return TimelineState(
      sessionId: sessionId,
      lastSeq: lastSeq ?? this.lastSeq,
      oldestIncludedSeq: oldestIncludedSeq ?? this.oldestIncludedSeq,
      messages: messages ?? this.messages,
      tools: tools ?? this.tools,
      lastRunStatus: lastRunStatus ?? this.lastRunStatus,
      sessionStatus: sessionStatus ?? this.sessionStatus,
      activeRunId: activeRunId ?? this.activeRunId,
      claudeSessionId: claudeSessionId ?? this.claudeSessionId,
      snapshotTruncated: snapshotTruncated ?? this.snapshotTruncated,
      seenEvents: seenEvents ?? this.seenEvents,
    );
  }
}

/// 应用一条时间线事件；重复 eventId 去重，冲突与乱序抛异常。
TimelineState applyEvent(TimelineState previous, TimelineEvent event) {
  if (event.sessionId != previous.sessionId) {
    throw ProtocolConflictException(
      'timeline mixes session ${event.sessionId} into ${previous.sessionId}',
    );
  }
  final fingerprint = _fingerprint(event);
  final known = previous.seenEvents[event.eventId];
  if (known != null) {
    if (known == fingerprint) return previous;
    throw ProtocolConflictException(
      'eventId ${event.eventId} retransmitted with different content',
    );
  }
  if (event.seq <= previous.lastSeq) {
    throw ProtocolConflictException(
      'seq ${event.seq} is not greater than ${previous.lastSeq}',
    );
  }
  final applied = _applyPayload(previous, event);
  return applied.copyWith(
    lastSeq: event.seq,
    seenEvents: {...previous.seenEvents, event.eventId: fingerprint},
  );
}

/// 用快照覆盖易失状态；保留本地更长的正文预览。
TimelineState applySnapshot(TimelineState previous, SessionSnapshot snapshot) {
  final snapshotSessionId = snapshot.sessionId;
  if (snapshotSessionId != null && snapshotSessionId != previous.sessionId) {
    throw ProtocolConflictException(
      'snapshot session $snapshotSessionId cannot replace ${previous.sessionId}',
    );
  }
  var next = TimelineState.initial(previous.sessionId);
  final seen = <String, String>{};
  for (final event in snapshot.events) {
    if (event.sessionId != previous.sessionId) {
      throw ProtocolConflictException(
        'snapshot mixes session ${event.sessionId} into ${previous.sessionId}',
      );
    }
    next = _applyPayload(next, event);
    seen[event.eventId] = _fingerprint(event);
  }
  return TimelineState(
    sessionId: previous.sessionId,
    lastSeq: snapshot.lastSeq,
    oldestIncludedSeq: snapshot.oldestIncludedSeq,
    messages: _preserveLongerText(previous.messages, next.messages),
    tools: next.tools,
    lastRunStatus: snapshot.lastRunStatus ?? next.lastRunStatus,
    sessionStatus: snapshot.sessionStatus ?? next.sessionStatus,
    activeRunId: snapshot.activeRunId,
    claudeSessionId: snapshot.claudeSessionId ?? next.claudeSessionId,
    snapshotTruncated: snapshot.snapshotTruncated,
    seenEvents: seen,
  );
}

TimelineState _applyPayload(TimelineState state, TimelineEvent event) {
  final payload = event.payload;
  switch (event.type) {
    case 'message.delta':
      return state.copyWith(
        messages: _upsertMessage(
          state.messages,
          _mergeDelta(state.messages, payload, event.timestamp),
        ),
      );
    case 'message.completed':
      return state.copyWith(
        messages: _upsertMessage(
          state.messages,
          _completeMessage(state.messages, payload, event.timestamp),
        ),
      );
    case 'tool.started':
      return state.copyWith(
        tools: _upsertTool(
          state.tools,
          _startTool(payload, event.timestamp),
        ),
      );
    case 'tool.output':
      return state.copyWith(
        tools: _upsertTool(
          state.tools,
          _appendToolOutput(state.tools, payload),
        ),
      );
    case 'tool.completed':
      return state.copyWith(
        tools: _upsertTool(
          state.tools,
          _completeTool(state.tools, payload),
        ),
      );
    case 'run.completed':
      return state.copyWith(
        lastRunStatus: RunStatus.tryParse(_stringOrNull(payload['status'])),
      );
    case 'session.status':
      return _applySessionStatus(state, payload);
    default:
      return state;
  }
}

TimelineState _applySessionStatus(
  TimelineState state,
  Map<String, Object?> payload,
) {
  return TimelineState(
    sessionId: state.sessionId,
    lastSeq: state.lastSeq,
    oldestIncludedSeq: state.oldestIncludedSeq,
    messages: state.messages,
    tools: state.tools,
    snapshotTruncated: state.snapshotTruncated,
    seenEvents: state.seenEvents,
    sessionStatus:
        _stringOrNull(payload['status']) ??
        _stringOrNull(payload['state']) ??
        state.sessionStatus,
    claudeSessionId:
        _stringOrNull(payload['claudeSessionId']) ?? state.claudeSessionId,
    activeRunId: payload.containsKey('activeRunId')
        ? _stringOrNull(payload['activeRunId'])
        : state.activeRunId,
    lastRunStatus:
        RunStatus.tryParse(_stringOrNull(payload['lastRunStatus'])) ??
        state.lastRunStatus,
  );
}

TimelineMessage _mergeDelta(
  List<TimelineMessage> messages,
  Map<String, Object?> payload,
  int createdAt,
) {
  final id = _requiredString(payload, 'assistantMessageId');
  final existing = _findMessage(messages, id);
  return TimelineMessage(
    assistantMessageId: id,
    text: '${existing?.text ?? ''}${_requiredString(payload, 'text')}',
    completed: existing?.completed ?? false,
    contentTruncated: existing?.contentTruncated ?? false,
    createdAt: existing?.createdAt ?? createdAt,
  );
}

TimelineMessage _completeMessage(
  List<TimelineMessage> messages,
  Map<String, Object?> payload,
  int createdAt,
) {
  final id = _requiredString(payload, 'assistantMessageId');
  final existing = _findMessage(messages, id);
  final truncated = payload['contentTruncated'] == true;
  return TimelineMessage(
    assistantMessageId: id,
    text: truncated ? (existing?.text ?? '') : _completedText(payload),
    completed: true,
    contentTruncated: truncated,
    createdAt: existing?.createdAt ?? createdAt,
  );
}

String _completedText(Map<String, Object?> payload) {
  final text = payload['text'];
  if (text is String) return text;
  final content = payload['content'];
  if (content is! List) return '';
  return content
      .whereType<Map<dynamic, dynamic>>()
      .map((block) => block['text'])
      .whereType<String>()
      .join();
}

TimelineTool _startTool(Map<String, Object?> payload, int createdAt) {
  final input = payload['input'];
  return TimelineTool(
    toolUseId: _requiredString(payload, 'toolUseId'),
    toolName: _requiredString(payload, 'toolName'),
    input: input is Map ? input.cast<String, Object?>() : const {},
    createdAt: createdAt,
  );
}

TimelineTool _appendToolOutput(
  List<TimelineTool> tools,
  Map<String, Object?> payload,
) {
  final existing = _findTool(tools, _requiredString(payload, 'toolUseId'));
  final chunk = payload['chunk'];
  return TimelineTool(
    toolUseId: existing?.toolUseId ?? _requiredString(payload, 'toolUseId'),
    toolName: existing?.toolName ?? '',
    input: existing?.input ?? const {},
    output: '${existing?.output ?? ''}${chunk is String ? chunk : ''}',
    status: existing?.status,
    isError: existing?.isError ?? false,
    summary: existing?.summary,
    outputTruncated:
        (existing?.outputTruncated ?? false) || payload['truncated'] == true,
    createdAt: existing?.createdAt ?? 0,
  );
}

TimelineTool _completeTool(
  List<TimelineTool> tools,
  Map<String, Object?> payload,
) {
  final existing = _findTool(tools, _requiredString(payload, 'toolUseId'));
  return TimelineTool(
    toolUseId: existing?.toolUseId ?? _requiredString(payload, 'toolUseId'),
    toolName: existing?.toolName ?? '',
    input: existing?.input ?? const {},
    output: existing?.output ?? '',
    status: _stringOrNull(payload['status']) ?? existing?.status,
    isError: payload['isError'] == true || (existing?.isError ?? false),
    summary: _stringOrNull(payload['summary']) ?? existing?.summary,
    outputTruncated: existing?.outputTruncated ?? false,
    createdAt: existing?.createdAt ?? 0,
  );
}

TimelineMessage? _findMessage(List<TimelineMessage> messages, String id) {
  for (final message in messages) {
    if (message.assistantMessageId == id) return message;
  }
  return null;
}

TimelineTool? _findTool(List<TimelineTool> tools, String id) {
  for (final tool in tools) {
    if (tool.toolUseId == id) return tool;
  }
  return null;
}

List<TimelineMessage> _upsertMessage(
  List<TimelineMessage> messages,
  TimelineMessage next,
) {
  final index = messages.indexWhere(
    (message) => message.assistantMessageId == next.assistantMessageId,
  );
  if (index < 0) return [...messages, next];
  final copy = [...messages];
  copy[index] = next;
  return copy;
}

List<TimelineTool> _upsertTool(List<TimelineTool> tools, TimelineTool next) {
  final index = tools.indexWhere((tool) => tool.toolUseId == next.toolUseId);
  if (index < 0) return [...tools, next];
  final copy = [...tools];
  copy[index] = next;
  return copy;
}

List<TimelineMessage> _preserveLongerText(
  List<TimelineMessage> previous,
  List<TimelineMessage> incoming,
) {
  final byId = {
    for (final message in previous) message.assistantMessageId: message,
  };
  return [
    for (final message in incoming)
      _longerText(byId[message.assistantMessageId], message),
  ];
}

TimelineMessage _longerText(TimelineMessage? local, TimelineMessage incoming) {
  if (local == null || local.text.length <= incoming.text.length) {
    return incoming;
  }
  return incoming.copyWith(text: local.text);
}

String _requiredString(Map<String, Object?> payload, String key) {
  final value = payload[key];
  return value is String ? value : '';
}

String? _stringOrNull(Object? value) => value is String ? value : null;

String _fingerprint(TimelineEvent event) {
  return jsonEncode({
    'eventId': event.eventId,
    'seq': event.seq,
    'type': event.type,
    'payload': event.payload,
  });
}