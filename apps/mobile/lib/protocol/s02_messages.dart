import '../connection/command_client.dart';
import '../data/agent_socket.dart' show JsonMap;
import '../domain/model_option.dart';
import '../domain/session.dart';
import '../domain/workspace.dart';

/// prompt.send 的首次结果；S04 起固定为 queued，starting 只来自 run.started。
final class PromptAccepted {
  const PromptAccepted({
    required this.sessionId,
    required this.runId,
    required this.status,
  });

  factory PromptAccepted.fromWire(JsonMap data) {
    final sessionId = data['sessionId'];
    final runId = data['runId'];
    final status = data['status'];
    if (sessionId is! String || sessionId.isEmpty) {
      throw const CommandFailure('INVALID_RESPONSE');
    }
    if (runId is! String || runId.isEmpty) {
      throw const CommandFailure('INVALID_RESPONSE');
    }
    if (status != 'queued') {
      throw const CommandFailure('INVALID_RESPONSE');
    }
    return PromptAccepted(sessionId: sessionId, runId: runId, status: status as String);
  }

  final String sessionId;
  final String runId;
  final String status;
}

/// 一页会话摘要。
final class SessionPage {
  const SessionPage({required this.sessions, this.nextCursor});

  factory SessionPage.fromWire(JsonMap data) {
    final rawSessions = data['sessions'];
    final nextCursor = data['nextCursor'];
    return SessionPage(
      sessions: rawSessions is List
          ? rawSessions
              .whereType<Map<dynamic, dynamic>>()
              .map((entry) => SessionSummary.fromWire(entry.cast<String, Object?>()))
              .where((session) => session.sessionId.isNotEmpty)
              .toList(growable: false)
          : const <SessionSummary>[],
      nextCursor: nextCursor is String && nextCursor.isNotEmpty
          ? nextCursor
          : null,
    );
  }

  final List<SessionSummary> sessions;
  final String? nextCursor;
}

/// queue.remove 的成功结果。
final class QueueRemovedResult {
  const QueueRemovedResult({
    required this.sessionId,
    required this.runId,
    required this.removed,
  });

  factory QueueRemovedResult.fromWire(JsonMap data) {
    final sessionId = data['sessionId'];
    final runId = data['runId'];
    if (sessionId is! String || runId is! String) {
      throw const CommandFailure('INVALID_RESPONSE');
    }
    return QueueRemovedResult(
      sessionId: sessionId,
      runId: runId,
      removed: data['removed'] == true,
    );
  }

  final String sessionId;
  final String runId;
  final bool removed;
}

/// S02 命令构造器；每个命令都可在超时后用同一实例重试。
abstract final class S02Commands {
  static CommandRequest<WorkspaceList> workspaceList({
    required String commandId,
    required String traceId,
  }) {
    return CommandRequest<WorkspaceList>(
      commandId: commandId,
      traceId: traceId,
      type: 'workspace.list',
      decode: WorkspaceList.fromWire,
    );
  }

  static CommandRequest<SessionSummary> sessionCreate({
    required String commandId,
    required String traceId,
    required String workspaceId,
    String? title,
  }) {
    return CommandRequest<SessionSummary>(
      commandId: commandId,
      traceId: traceId,
      type: 'session.create',
      payload: {
        'workspaceId': workspaceId,
        'title': ?title,
      },
      decode: SessionSummary.fromWire,
    );
  }

  static CommandRequest<SessionPage> sessionList({
    required String commandId,
    required String traceId,
    required String workspaceId,
    bool includeArchived = false,
    int? limit,
    String? cursor,
  }) {
    return CommandRequest<SessionPage>(
      commandId: commandId,
      traceId: traceId,
      type: 'session.list',
      payload: {
        'workspaceId': workspaceId,
        if (includeArchived) 'includeArchived': true,
        'limit': ?limit,
        'cursor': ?cursor,
      },
      decode: SessionPage.fromWire,
    );
  }

  static CommandRequest<SessionSummary> sessionResume({
    required String commandId,
    required String traceId,
    required String sessionId,
  }) {
    return CommandRequest<SessionSummary>(
      commandId: commandId,
      traceId: traceId,
      type: 'session.resume',
      sessionId: sessionId,
      payload: {'sessionId': sessionId},
      decode: SessionSummary.fromWire,
    );
  }

  static CommandRequest<SessionSummary> sessionRename({
    required String commandId,
    required String traceId,
    required String sessionId,
    required String title,
  }) {
    return CommandRequest<SessionSummary>(
      commandId: commandId,
      traceId: traceId,
      type: 'session.rename',
      sessionId: sessionId,
      payload: {'sessionId': sessionId, 'title': title},
      decode: SessionSummary.fromWire,
    );
  }

  static CommandRequest<SessionSummary> sessionArchive({
    required String commandId,
    required String traceId,
    required String sessionId,
  }) {
    return CommandRequest<SessionSummary>(
      commandId: commandId,
      traceId: traceId,
      type: 'session.archive',
      sessionId: sessionId,
      payload: {'sessionId': sessionId},
      decode: SessionSummary.fromWire,
    );
  }

  static CommandRequest<PromptAccepted> promptSend({
    required String commandId,
    required String traceId,
    required String sessionId,
    required String text,
    List<Map<String, Object?>> attachments = const <Map<String, Object?>>[],
  }) {
    return CommandRequest<PromptAccepted>(
      commandId: commandId,
      traceId: traceId,
      type: 'prompt.send',
      sessionId: sessionId,
      payload: {
        'text': text,
        if (attachments.isNotEmpty) 'attachments': attachments,
      },
      decode: PromptAccepted.fromWire,
    );
  }

  static CommandRequest<QueueRemovedResult> queueRemove({
    required String commandId,
    required String traceId,
    required String sessionId,
    required String runId,
  }) {
    return CommandRequest<QueueRemovedResult>(
      commandId: commandId,
      traceId: traceId,
      type: 'queue.remove',
      sessionId: sessionId,
      runId: runId,
      decode: QueueRemovedResult.fromWire,
    );
  }

  static CommandRequest<ModelCatalog> modelsList({
    required String commandId,
    required String traceId,
    required String workspaceId,
  }) {
    return CommandRequest<ModelCatalog>(
      commandId: commandId,
      traceId: traceId,
      type: 'models.list',
      payload: {'workspaceId': workspaceId},
      decode: ModelCatalog.fromWire,
    );
  }

  /// model 为 null 表示跟随 Mac 端默认模型；序列化为 JSON null。
  static CommandRequest<SessionSummary> sessionSetModel({
    required String commandId,
    required String traceId,
    required String sessionId,
    required String? model,
  }) {
    return CommandRequest<SessionSummary>(
      commandId: commandId,
      traceId: traceId,
      type: 'session.set-model',
      sessionId: sessionId,
      payload: {'model': model},
      decode: SessionSummary.fromWire,
    );
  }
}