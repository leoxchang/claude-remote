import '../../connection/command_client.dart';
import '../../data/agent_socket.dart' show JsonMap;

/// 本地受管会话摘要；S01 同时只有一个。
final class SessionRecord {
  const SessionRecord({
    required this.sessionId,
    this.claudeSessionId,
    this.desktopId,
  });

  final String sessionId;
  final String? claudeSessionId;
  final String? desktopId;
}

/// 会话附着与快照；S01 不支持多会话。
final class SessionController {
  SessionController({
    required this.client,
    required this.readSessionId,
    required this.writeSessionId,
  });

  final CommandClient client;
  final String? Function() readSessionId;
  final void Function(String sessionId) writeSessionId;

  int _sequence = 0;

  /// 已有本地会话则请求快照，否则创建（或附着）唯一会话。
  Future<SessionRecord> startOrAttach() async {
    final existing = readSessionId();
    if (existing != null) {
      await refreshSnapshot();
      return SessionRecord(sessionId: existing);
    }
    final data = await client.execute<JsonMap>(
      CommandRequest<JsonMap>(
        commandId: _nextId('cmd_start'),
        traceId: _nextId('trace'),
        type: 'session.start',
        payload: {
          'clientCapabilities': ['text', 'message.delta'],
          'workspaceId': 'default',
        },
        decode: (json) => json,
      ),
    );
    final sessionId = data['sessionId'];
    if (sessionId is! String || sessionId.isEmpty) {
      throw const CommandFailure('SESSION_START_FAILED');
    }
    writeSessionId(sessionId);
    final claudeSessionId = data['claudeSessionId'];
    return SessionRecord(
      sessionId: sessionId,
      claudeSessionId: claudeSessionId is String ? claudeSessionId : null,
    );
  }

  /// 请求当前会话快照；快照本身由事件通道送达。
  Future<void> refreshSnapshot() async {
    final sessionId = readSessionId();
    if (sessionId == null) return;
    await client.execute<JsonMap>(
      CommandRequest<JsonMap>(
        commandId: _nextId('cmd_snapshot'),
        traceId: _nextId('trace'),
        type: 'session.snapshot',
        sessionId: sessionId,
        payload: const <String, dynamic>{},
        decode: (json) => json,
      ),
    );
  }

  String _nextId(String prefix) {
    _sequence += 1;
    return '${prefix}_${DateTime.now().microsecondsSinceEpoch}_$_sequence';
  }
}