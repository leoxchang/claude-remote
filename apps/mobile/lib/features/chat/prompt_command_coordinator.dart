import 'dart:async';

import 'package:sqflite/sqflite.dart';

import '../../connection/command_client.dart';
import '../../protocol/s02_messages.dart';
import '../../connection/persistent_command_coordinator.dart';

/// 结果未知的 prompt；保留原会话与请求，绝不自动生成新 commandId。
final class UnknownPrompt {
  const UnknownPrompt({
    required this.sessionId,
    required this.request,
    required this.reason,
  });

  final String sessionId;
  final CommandRequest<PromptAccepted> request;

  /// `connection-lost` 或 `agent-restarted`。
  final String reason;
}

/// 每会话最多一个未确认 prompt；负责原样重试与重启失效。
final class PromptCommandCoordinator {
  PromptCommandCoordinator({
    required this.client,
    this.timeout = const Duration(seconds: 10),
    this.retryDelay = const Duration(seconds: 5),
    this.persistent,
  });

  final CommandClient client;
  final Duration timeout;
  final Duration retryDelay;
  /// S04：存在时 prompt.send 先持久化再发送。
  final PersistentCommandCoordinator? persistent;

  final Map<String, CommandRequest<PromptAccepted>> _pending =
      <String, CommandRequest<PromptAccepted>>{};
  final Map<String, Timer> _retryTimers = <String, Timer>{};
  final Map<String, String> _unknownReasons = <String, String>{};

  /// 语音草稿消费回调；同一 commandId 的重试沿用。
  final Map<String, FutureOr<void> Function(Transaction txn)>
  _withinTransaction = <String, FutureOr<void> Function(Transaction txn)>{};

  /// 该会话没有未确认 prompt 时才允许发送新命令。
  bool canSend(String sessionId) => !_pending.containsKey(sessionId);

  /// 结果未知的 prompt；没有时返回 null。
  UnknownPrompt? unknownFor(String sessionId) {
    final request = _pending[sessionId];
    final reason = _unknownReasons[sessionId];
    if (request == null || reason == null) return null;
    return UnknownPrompt(
      sessionId: sessionId,
      request: request,
      reason: reason,
    );
  }

  /// 发送一条 prompt；同一会话同时只允许一条。
  Future<PromptAccepted> send(
    CommandRequest<PromptAccepted> request, {
    FutureOr<void> Function(Transaction txn)? withinTransaction,
  }) async {
    final sessionId = request.sessionId;
    if (sessionId == null) {
      throw const CommandFailure('INVALID_REQUEST');
    }
    if (!canSend(sessionId)) {
      throw const CommandFailure('PROMPT_PENDING');
    }
    if (withinTransaction != null) {
      _withinTransaction[sessionId] = withinTransaction;
    }
    _pending[sessionId] = request;
    return _execute(sessionId, request);
  }

  /// 用同一 request（同一 commandId）重试。
  Future<PromptAccepted> retry(String sessionId) async {
    final request = _pending[sessionId];
    if (request == null) {
      throw const CommandFailure('NO_PENDING_PROMPT');
    }
    _cancelTimer(sessionId);
    return _execute(sessionId, request);
  }

  /// Agent 新实例使所有未确认 prompt 失效；取消自动重试，等待用户处理。
  void invalidateForRestart() {
    for (final sessionId in _pending.keys.toList()) {
      _unknownReasons[sessionId] = 'agent-restarted';
      _cancelTimer(sessionId);
    }
  }

  /// 用户放弃结果未知的 prompt 后，该会话可再次发送。
  void discardUnknown(String sessionId) {
    _pending.remove(sessionId);
    _unknownReasons.remove(sessionId);
    _cancelTimer(sessionId);
  }

  Future<PromptAccepted> _execute(
    String sessionId,
    CommandRequest<PromptAccepted> request,
  ) async {
    try {
      final PromptAccepted result;
      final persistent = this.persistent;
      if (persistent != null && request.type == 'prompt.send') {
        final wire = await persistent.send(
          commandId: request.commandId,
          sessionId: sessionId,
          type: request.type,
          payload: request.payload,
          withinTransaction: _withinTransaction[sessionId],
        );
        try {
          result = request.decode(wire);
        } finally {
          // Mac 已接受：即使本地解码失败也必须结束 outbox，避免永久门控。
          await persistent.onConfirmed(request.commandId);
        }
      } else {
        result = await client.execute(request, timeout: timeout);
      }
      _pending.remove(sessionId);
      _unknownReasons.remove(sessionId);
      _withinTransaction.remove(sessionId);
      _cancelTimer(sessionId);
      return result;
    } on CommandTimeout {
      _unknownReasons[sessionId] = 'connection-lost';
      _scheduleRetry(sessionId);
      rethrow;
    } on CommandFailure {
      _pending.remove(sessionId);
      _unknownReasons.remove(sessionId);
      _withinTransaction.remove(sessionId);
      _cancelTimer(sessionId);
      rethrow;
    }
  }

  void _scheduleRetry(String sessionId) {
    _cancelTimer(sessionId);
    _retryTimers[sessionId] = Timer(retryDelay, () {
      _retryTimers.remove(sessionId);
      if (!_pending.containsKey(sessionId)) return;
      unawaited(
        retry(sessionId).then((_) {}, onError: (Object _) {}),
      );
    });
  }

  void _cancelTimer(String sessionId) {
    final timer = _retryTimers.remove(sessionId);
    timer?.cancel();
  }
}