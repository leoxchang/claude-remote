import 'package:sqflite/sqflite.dart';

/// 未确认 mutating command 的本地状态机。
enum OutboxState {
  persisted('persisted'),
  sending('sending'),
  awaitingAck('awaiting_ack'),
  confirmationRequired('confirmation_required'),
  completed('completed'),
  discarded('discarded');

  const OutboxState(this.value);

  final String value;

  static OutboxState fromValue(String value) {
    return OutboxState.values.firstWhere(
      (state) => state.value == value,
      orElse: () => OutboxState.persisted,
    );
  }
}

/// outbox 中的一条命令；payload 只在确定 result 前保存。
final class OutboxCommand {
  const OutboxCommand({
    required this.commandId,
    required this.sessionId,
    required this.type,
    required this.payloadJson,
    required this.agentInstanceId,
    required this.state,
    required this.createdAt,
    required this.updatedAt,
  });

  final String commandId;
  final String sessionId;
  final String type;
  final String? payloadJson;
  final String? agentInstanceId;
  final OutboxState state;
  final int createdAt;
  final int updatedAt;

  OutboxCommand copyWith({
    String? payloadJson,
    String? agentInstanceId,
    OutboxState? state,
    int? updatedAt,
  }) {
    return OutboxCommand(
      commandId: commandId,
      sessionId: sessionId,
      type: type,
      payloadJson: payloadJson ?? this.payloadJson,
      agentInstanceId: agentInstanceId ?? this.agentInstanceId,
      state: state ?? this.state,
      createdAt: createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }
}

/// 持久执行意图；同 session 的 prompt.send/run.requeue 最多一条未确认。
final class OutboxRepository {
  const OutboxRepository(this.db);

  final Database db;

  static const Set<OutboxState> _blockingStates = {
    OutboxState.persisted,
    OutboxState.sending,
    OutboxState.awaitingAck,
    OutboxState.confirmationRequired,
  };

  Future<void> insert(OutboxCommand command) {
    return db.transaction((txn) => insertWithin(txn, command));
  }

  /// 在调用方事务内插入；用于草稿消费等同事务场景。
  Future<void> insertWithin(Transaction txn, OutboxCommand command) {
    return txn.insert('outbox_commands', {
      'commandId': command.commandId,
      'sessionId': command.sessionId,
      'type': command.type,
      'payloadJson': command.payloadJson,
      'agentInstanceId': command.agentInstanceId,
      'state': command.state.value,
      'createdAt': command.createdAt,
      'updatedAt': command.updatedAt,
    }, conflictAlgorithm: ConflictAlgorithm.abort);
  }

  Future<void> updateState(
    String commandId,
    OutboxState state, {
    int? updatedAt,
  }) {
    return db.update(
      'outbox_commands',
      {
        'state': state.value,
        'updatedAt': updatedAt ?? DateTime.now().millisecondsSinceEpoch,
      },
      where: 'commandId = ?',
      whereArgs: [commandId],
    );
  }

  Future<void> updateAgentInstance(
    String commandId,
    String? agentInstanceId,
  ) {
    return db.update(
      'outbox_commands',
      {
        'agentInstanceId': agentInstanceId,
        'updatedAt': DateTime.now().millisecondsSinceEpoch,
      },
      where: 'commandId = ?',
      whereArgs: [commandId],
    );
  }

  /// 确定 result 后清正文，保留最小 UI 墓碑。
  Future<void> clearPayload(String commandId, {OutboxState? state}) {
    return db.update(
      'outbox_commands',
      {
        'payloadJson': null,
        'state': (state ?? OutboxState.completed).value,
        'updatedAt': DateTime.now().millisecondsSinceEpoch,
      },
      where: 'commandId = ?',
      whereArgs: [commandId],
    );
  }

  Future<void> delete(String commandId) {
    return db.delete(
      'outbox_commands',
      where: 'commandId = ?',
      whereArgs: [commandId],
    );
  }

  Future<OutboxCommand?> find(String commandId) async {
    final rows = await db.query(
      'outbox_commands',
      where: 'commandId = ?',
      whereArgs: [commandId],
      limit: 1,
    );
    return rows.isEmpty ? null : _fromRow(rows.first);
  }

  /// 同 session 的阻塞执行意图；最多一条。
  Future<OutboxCommand?> activeIntentForSession(String sessionId) async {
    final placeholders = _blockingStates.map((_) => '?').join(', ');
    final rows = await db.query(
      'outbox_commands',
      where: "sessionId = ? AND type IN ('prompt.send', 'run.requeue') AND state IN ($placeholders)",
      whereArgs: [
        sessionId,
        ..._blockingStates.map((state) => state.value),
      ],
      limit: 1,
    );
    return rows.isEmpty ? null : _fromRow(rows.first);
  }

  Future<bool> hasExecutionIntent(String sessionId) async {
    return await activeIntentForSession(sessionId) != null;
  }

  Future<List<OutboxCommand>> listActive() async {
    final placeholders = _blockingStates.map((_) => '?').join(', ');
    final rows = await db.query(
      'outbox_commands',
      where: 'state IN ($placeholders)',
      whereArgs: _blockingStates.map((state) => state.value).toList(),
      orderBy: 'createdAt ASC',
    );
    return rows.map(_fromRow).toList(growable: false);
  }

  Future<List<OutboxCommand>> all() async {
    final rows = await db.query(
      'outbox_commands',
      orderBy: 'createdAt ASC',
    );
    return rows.map(_fromRow).toList(growable: false);
  }

  Future<void> clearAll() => db.delete('outbox_commands');

  OutboxCommand _fromRow(Map<String, Object?> row) {
    return OutboxCommand(
      commandId: row['commandId'] as String,
      sessionId: row['sessionId'] as String,
      type: row['type'] as String,
      payloadJson: row['payloadJson'] as String?,
      agentInstanceId: row['agentInstanceId'] as String?,
      state: OutboxState.fromValue(row['state'] as String),
      createdAt: row['createdAt'] as int,
      updatedAt: row['updatedAt'] as int,
    );
  }
}