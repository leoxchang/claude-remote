import 'dart:async';

import '../data/agent_socket.dart' show JsonMap;
import '../recovery/outbox_command.dart';
import '../recovery/outbox_repository.dart';
import 'command_client.dart';

/// 投递结果；由传输层把 payload 解码成 JsonMap。
typedef OutboxDeliver = Future<JsonMap> Function(PersistedCommandSnapshot snapshot);

/// 需要持久化的执行意图类型。
const Set<String> executionIntentTypes = {'prompt.send', 'run.requeue'};

/// 先持久化再发送的 mutating 命令协调器。
///
/// agentInstanceId 改变后不再自动重试，必须由用户确认；
/// 同 session 最多一条未确认的 prompt.send/run.requeue。
final class PersistentCommandCoordinator {
  PersistentCommandCoordinator({
    required OutboxRepository outbox,
    required OutboxDeliver deliver,
    DateTime Function()? clock,
    this.retryDelay = const Duration(seconds: 1),
    void Function() Function(Duration, void Function())? schedule,
  }) : _outbox = outbox,
       _deliver = deliver,
       _clock = clock ?? DateTime.now,
       _schedule = schedule ?? _defaultSchedule;

  final OutboxRepository _outbox;
  final OutboxDeliver _deliver;
  final DateTime Function() _clock;
  final Duration retryDelay;
  final void Function() Function(Duration, void Function()) _schedule;
  final Map<String, void Function()> _timers = {};
  String? _agentInstanceId;
  int _generation = 0;

  /// Agent 实例变化：旧未确认意图转 confirmation_required 并停止 timer。
  Future<void> onReady(String agentInstanceId) async {
    _agentInstanceId = agentInstanceId;
    _generation += 1;
    final active = await _outbox.listActive();
    for (final command in active) {
      final timer = _timers.remove(command.commandId);
      timer?.call();
      final previous = command.agentInstanceId;
      if (previous != null && previous != agentInstanceId) {
        await _outbox.updateState(
          command.commandId,
          OutboxState.confirmationRequired,
          updatedAt: _now,
        );
        continue;
      }
      await _outbox.updateAgentInstance(command.commandId, agentInstanceId);
      if (command.state == OutboxState.persisted ||
          command.state == OutboxState.sending ||
          command.state == OutboxState.awaitingAck) {
        // awaiting_ack 的 result 可能已丢失；同实例重投由 Mac 按 commandId 去重。
        await _deliverNow(command.commandId, autoRetry: true);
      }
    }
  }

  /// 先写 outbox 再投递；网络失败保留同一 commandId。
  Future<JsonMap> send({
    required String commandId,
    required String sessionId,
    required String type,
    required Map<String, Object?> payload,
  }) async {
    final existing = await _outbox.find(commandId);
    if (existing == null) {
      if (executionIntentTypes.contains(type)) {
        final active = await _outbox.activeIntentForSession(sessionId);
        if (active != null && active.commandId != commandId) {
          throw const CommandFailure('SESSION_BUSY');
        }
      }
      await _outbox.insert(
        OutboxCommand(
          commandId: commandId,
          sessionId: sessionId,
          type: type,
          payloadJson: PersistedCommandSnapshot(
            commandId: commandId,
            sessionId: sessionId,
            type: type,
            payload: payload,
            agentInstanceId: _agentInstanceId,
          ).payloadJson,
          agentInstanceId: _agentInstanceId,
          state: OutboxState.persisted,
          createdAt: _now,
          updatedAt: _now,
        ),
      );
    } else if (existing.state == OutboxState.confirmationRequired) {
      throw const CommandFailure('CONFIRMATION_REQUIRED');
    }
    return _deliverNow(commandId, autoRetry: true);
  }

  /// 用户确认旧实例的未确认意图；仍使用原 commandId/正文。
  Future<JsonMap> confirmRetry(String commandId) async {
    final command = await _outbox.find(commandId);
    if (command == null) throw const CommandFailure('RUN_NOT_FOUND');
    if (command.state != OutboxState.confirmationRequired) {
      throw const CommandFailure('INVALID_MESSAGE');
    }
    await _outbox.updateAgentInstance(commandId, _agentInstanceId);
    await _outbox.updateState(
      commandId,
      OutboxState.persisted,
      updatedAt: _now,
    );
    return _deliverNow(commandId, autoRetry: false);
  }

  /// 放弃本地重试：只清本地正文，不撤销 Mac 已接受的执行。
  Future<void> discardUnknown(String commandId) async {
    final timer = _timers.remove(commandId);
    timer?.call();
    await _outbox.clearPayload(commandId, state: OutboxState.discarded);
  }

  /// 收到确定 result 后结束执行意图。
  Future<void> onConfirmed(String commandId) async {
    final timer = _timers.remove(commandId);
    timer?.call();
    await _outbox.clearPayload(commandId);
  }

  /// 不可确认的存储错误保留；其他业务错误结束 outbox。
  Future<void> onFailure(String commandId, String code) async {
    if (code == 'STORAGE_UNAVAILABLE') {
      final timer = _timers.remove(commandId);
      timer?.call();
      await _outbox.updateState(
        commandId,
        OutboxState.persisted,
        updatedAt: _now,
      );
      return;
    }
    if (code == 'INVALID_MESSAGE' || code == 'VERSION_INCOMPATIBLE') {
      await _outbox.clearPayload(commandId, state: OutboxState.discarded);
      return;
    }
    await onConfirmed(commandId);
  }

  /// 持久唯一门控：同 session 是否已有未确认执行意图。
  Future<bool> canStartExecutionIntent(String sessionId) async {
    return !await _outbox.hasExecutionIntent(sessionId);
  }

  Future<List<OutboxCommand>> pending() => _outbox.listActive();

  Future<JsonMap> _deliverNow(
    String commandId, {
    required bool autoRetry,
  }) async {
    final command = await _outbox.find(commandId);
    if (command == null || command.payloadJson == null) {
      throw const CommandFailure('RUN_NOT_FOUND');
    }
    await _outbox.updateState(
      commandId,
      OutboxState.sending,
      updatedAt: _now,
    );
    final generation = _generation;
    try {
      final result = await _deliver(
        PersistedCommandSnapshot(
          commandId: command.commandId,
          sessionId: command.sessionId,
          type: command.type,
          payload: PersistedCommandSnapshot.decodePayload(command.payloadJson),
          agentInstanceId: command.agentInstanceId,
        ),
      );
      await _outbox.updateState(
        commandId,
        OutboxState.awaitingAck,
        updatedAt: _now,
      );
      return result;
    } on CommandFailure catch (error) {
      await onFailure(commandId, error.code);
      rethrow;
    } on Object {
      await _outbox.updateState(
        commandId,
        OutboxState.persisted,
        updatedAt: _now,
      );
      if (autoRetry && generation == _generation) {
        final timer = _schedule(retryDelay, () {
          if (generation != _generation) return;
          unawaited(_retrySilently(commandId));
        });
        _timers[commandId] = timer;
      }
      rethrow;
    }
  }

  Future<void> _retrySilently(String commandId) async {
    try {
      await _deliverNow(commandId, autoRetry: true);
    } on Object {
      // 保留 persisted；下一次 ready 或用户操作再重试。
    }
  }

  int get _now => _clock().millisecondsSinceEpoch;

  static void Function() _defaultSchedule(
    Duration duration,
    void Function() callback,
  ) {
    final timer = Timer(duration, callback);
    return () => timer.cancel();
  }

}