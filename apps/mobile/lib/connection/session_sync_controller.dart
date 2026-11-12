import 'dart:async';

import '../domain/session.dart';
import 'command_client.dart';

/// 目标会话快照的拉取与分发；只替换目标会话状态。
final class SessionSyncController {
  SessionSyncController({
    required this.client,
    required this.currentSessionId,
    required this.activeSessionIds,
    required this.newId,
    required this.onSnapshot,
  });

  final CommandClient client;
  final String? Function() currentSessionId;
  final Iterable<String> Function() activeSessionIds;
  final String Function(String prefix) newId;
  final void Function(SessionSnapshot snapshot) onSnapshot;

  /// 请求指定会话的完整有界快照。
  Future<void> refreshSnapshot(String sessionId) async {
    final request = CommandRequest<SessionSnapshot>(
      commandId: newId('cmd_snapshot'),
      traceId: newId('trace'),
      type: 'session.snapshot',
      sessionId: sessionId,
      payload: <String, dynamic>{'sessionId': sessionId},
      decode: _decodeSnapshot,
    );
    final snapshot = await client.execute(request);
    onSnapshot(snapshot);
  }

  /// 当前会话优先，其余活跃会话依次刷新；同一会话只请求一次。
  Future<void> refreshCurrentAndActive() async {
    final ordered = <String>[];
    final current = currentSessionId();
    if (current != null && current.isNotEmpty) ordered.add(current);
    for (final sessionId in activeSessionIds()) {
      if (!ordered.contains(sessionId)) ordered.add(sessionId);
    }
    await Future.wait(
      ordered.map(refreshSnapshot),
    );
  }

  static SessionSnapshot _decodeSnapshot(Map<String, dynamic> data) {
    final snapshot = data['snapshot'];
    if (snapshot is! Map) {
      throw const CommandFailure('INVALID_RESPONSE');
    }
    return SessionSnapshot.fromPayload(snapshot.cast<String, Object?>());
  }
}