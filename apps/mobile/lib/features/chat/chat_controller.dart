import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../connection/command_client.dart';
import '../../connection/connection_controller.dart';
import '../../data/agent_socket.dart';
import '../../data/providers.dart' show commandClientProvider;
import '../../domain/run.dart';
import '../../domain/session.dart';
import '../../domain/timeline.dart';
import '../../protocol/messages.dart';

/// S01 单条 prompt 的 UTF-8 字节上限。
const int maxPromptBytes = 16384;

/// 工具输出在 App 内保留的最大预览字符数。
const int maxToolPreviewChars = 256 * 1024;

/// Composer 的四种状态；与 spec §13.2 对齐。
enum ComposerStatus { idle, sending, unknown }

/// 聊天页的不可变状态。
final class ChatState {
  const ChatState({
    this.connection = ConnectionStatus.disconnected,
    this.syncing = false,
    this.draft = '',
    this.composer = ComposerStatus.idle,
    this.error,
    this.activeRunId,
    this.cancelling = false,
    this.unknownCommandId,
    this.lastRunStatus,
    this.timeline,
    this.snapshotTruncated = false,
  });

  final ConnectionStatus connection;
  final bool syncing;
  final String draft;
  final ComposerStatus composer;
  final String? error;
  final String? activeRunId;
  final bool cancelling;
  final String? unknownCommandId;
  final RunStatus? lastRunStatus;
  final TimelineState? timeline;
  final bool snapshotTruncated;

  int get draftBytes => utf8.encode(draft).length;

  bool get busy => activeRunId != null;

  bool get canSend =>
      connection == ConnectionStatus.ready &&
      !syncing &&
      !busy &&
      composer == ComposerStatus.idle &&
      draftBytes > 0 &&
      draftBytes <= maxPromptBytes;

  ChatState copyWith({
    ConnectionStatus? connection,
    bool? syncing,
    String? draft,
    ComposerStatus? composer,
    Object? error = _unset,
    Object? activeRunId = _unset,
    bool? cancelling,
    Object? unknownCommandId = _unset,
    Object? lastRunStatus = _unset,
    TimelineState? timeline,
    bool? snapshotTruncated,
  }) {
    return ChatState(
      connection: connection ?? this.connection,
      syncing: syncing ?? this.syncing,
      draft: draft ?? this.draft,
      composer: composer ?? this.composer,
      error: identical(error, _unset) ? this.error : error as String?,
      activeRunId: identical(activeRunId, _unset)
          ? this.activeRunId
          : activeRunId as String?,
      cancelling: cancelling ?? this.cancelling,
      unknownCommandId: identical(unknownCommandId, _unset)
          ? this.unknownCommandId
          : unknownCommandId as String?,
      lastRunStatus: identical(lastRunStatus, _unset)
          ? this.lastRunStatus
          : lastRunStatus as RunStatus?,
      timeline: timeline ?? this.timeline,
      snapshotTruncated: snapshotTruncated ?? this.snapshotTruncated,
    );
  }

  static const Object _unset = Object();
}

/// 单条命令的等待上限；测试可缩短。
final promptTimeoutProvider = Provider<Duration>(
  (ref) => const Duration(seconds: 10),
);

/// 聊天页控制器：组合连接、会话、run 与 composer 状态。
final chatControllerProvider = NotifierProvider<ChatController, ChatState>(
  ChatController.new,
);

final class ChatController extends Notifier<ChatState> {
  String? _sessionId;
  CommandRequest<JsonMap>? _pendingPrompt;
  int _sequence = 0;

  @override
  ChatState build() => const ChatState();

  /// 测试和启动流程用于注入当前会话。
  void attachSession(String sessionId) {
    _sessionId = sessionId;
  }

  /// 当前本地会话；未附着时为 null。
  String? get sessionId => _sessionId;

  /// 运行时错误的安全摘要。
  void reportError(String message) {
    state = state.copyWith(error: message);
  }

  void setConnection(ConnectionStatus status) {
    state = state.copyWith(connection: status);
  }

  void setSyncing(bool syncing) {
    state = state.copyWith(syncing: syncing);
  }

  void updateDraft(String draft) {
    state = state.copyWith(draft: draft, error: null);
  }

  /// 应用一条时间线事件；run.completed 清空忙碌状态。
  void mergeEvent(TimelineEvent event) {
    final current = state.timeline ?? TimelineState.initial(event.sessionId);
    final next = applyEvent(current, event);
    final status = event.type == 'run.completed'
        ? RunStatus.tryParse(event.payload['status'] as String?)
        : null;
    state = state.copyWith(
      timeline: next,
      lastRunStatus: status ?? state.lastRunStatus,
      activeRunId: event.type == 'run.completed' ? null : state.activeRunId,
      cancelling: event.type == 'run.completed' ? false : state.cancelling,
    );
  }

  /// 用快照覆盖时间线，并记录截断标记。
  void mergeSnapshot(SessionSnapshot snapshot) {
    final current = state.timeline ?? TimelineState.initial('');
    final next = applySnapshot(current, snapshot);
    state = state.copyWith(
      timeline: next,
      snapshotTruncated: snapshot.snapshotTruncated,
      lastRunStatus: snapshot.lastRunStatus ?? state.lastRunStatus,
      activeRunId: snapshot.activeRunId,
      syncing: false,
    );
  }

  /// 发送当前草稿；不可发送条件在本地直接拒绝，不产生 commandId。
  Future<void> sendText() async {
    if (state.draftBytes > maxPromptBytes) {
      state = state.copyWith(error: '内容超过 16 KiB 上限');
      return;
    }
    if (!state.canSend) {
      state = state.copyWith(error: _blockedReason());
      return;
    }
    final sessionId = _sessionId;
    final client = await ref.read(commandClientProvider.future);
    if (sessionId == null || client == null) {
      state = state.copyWith(error: '尚未连接 Mac 或会话未就绪');
      return;
    }
    final request = CommandRequest<JsonMap>(
      commandId: _nextId('cmd_prompt'),
      traceId: _nextId('trace'),
      type: 'prompt.send',
      sessionId: sessionId,
      payload: {'text': state.draft},
      decode: (json) => json,
    );
    _pendingPrompt = request;
    state = state.copyWith(composer: ComposerStatus.sending, error: null);
    await _executePrompt(request, client);
  }

  /// 结果未知时用同一 commandId 重试，不生成新命令。
  Future<void> retryUnknownCommand() async {
    final request = _pendingPrompt;
    if (request == null) return;
    final client = await ref.read(commandClientProvider.future);
    if (client == null) {
      state = state.copyWith(error: '尚未连接 Mac');
      return;
    }
    state = state.copyWith(composer: ComposerStatus.sending, error: null);
    await _executePrompt(request, client);
  }

  /// 停止当前 run；cancelling 期间按钮禁用。
  Future<void> cancelActiveRun() async {
    final runId = state.activeRunId;
    final sessionId = _sessionId;
    if (runId == null || sessionId == null || state.cancelling) return;
    final client = await ref.read(commandClientProvider.future);
    if (client == null) return;
    state = state.copyWith(cancelling: true, error: null);
    try {
      await client.execute<JsonMap>(
        CommandRequest<JsonMap>(
          commandId: _nextId('cmd_cancel'),
          traceId: _nextId('trace'),
          type: 'run.cancel',
          sessionId: sessionId,
          runId: runId,
          payload: {'reason': 'user_requested'},
          decode: (json) => json,
        ),
      );
    } on CommandFailure catch (error) {
      state = state.copyWith(cancelling: false, error: _messageFor(error.code));
    } on CommandTimeout {
      state = state.copyWith(cancelling: false, error: '停止请求超时，请重试');
    }
  }

  Future<void> _executePrompt(
    CommandRequest<JsonMap> request,
    CommandClient client,
  ) async {
    try {
      final data = await client.execute<JsonMap>(
        request,
        timeout: ref.read(promptTimeoutProvider),
      );
      final runId = data['runId'];
      state = state.copyWith(
        draft: '',
        composer: ComposerStatus.idle,
        activeRunId: runId is String ? runId : null,
        unknownCommandId: null,
        error: null,
      );
    } on CommandFailure catch (error) {
      state = state.copyWith(
        composer: ComposerStatus.idle,
        error: _messageFor(error.code),
      );
    } on CommandTimeout {
      state = state.copyWith(
        composer: ComposerStatus.unknown,
        unknownCommandId: request.commandId,
        error: '结果未知，可用同一命令重试',
      );
    }
  }

  String _blockedReason() {
    if (state.connection != ConnectionStatus.ready) return 'Mac 未连接';
    if (state.syncing) return '正在同步，请稍候';
    if (state.busy) return '当前会话已有任务执行';
    if (state.draftBytes == 0) return '请输入内容';
    return '当前不可发送';
  }

  String _messageFor(String code) {
    return switch (code) {
      'SESSION_BUSY' => '当前会话已有任务执行',
      'SESSION_NOT_FOUND' => '会话已失效，请重新同步',
      'DEVICE_REVOKED' => '设备已被吊销，请重新配对',
      'PERMISSION_REQUIRED' => '该操作需要审批，S01 不支持',
      _ => '发送失败（$code）',
    };
  }

  String _nextId(String prefix) {
    _sequence += 1;
    return '${prefix}_${DateTime.now().microsecondsSinceEpoch}_$_sequence';
  }
}