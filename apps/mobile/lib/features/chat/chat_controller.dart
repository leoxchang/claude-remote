import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../connection/command_client.dart';
import '../../connection/connection_controller.dart';
import '../../connection/persistent_command_coordinator.dart';
import '../../data/agent_socket.dart';
import '../../data/providers.dart' show commandClientProvider;
import '../../domain/run.dart';
import '../../domain/session.dart';
import '../../domain/timeline.dart';
import '../../protocol/messages.dart';
import '../../protocol/s02_messages.dart';
import 'prompt_command_coordinator.dart';

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
    this.queue = const <QueuedRunSummary>[],
    this.queuePreviews = const <String, String>{},
    this.archived = false,
    this.slotsFull = false,
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
  final List<QueuedRunSummary> queue;
  final Map<String, String> queuePreviews;
  final bool archived;
  final bool slotsFull;

  int get draftBytes => utf8.encode(draft).length;

  bool get busy => activeRunId != null;

  /// 有活跃 run 或全局槽已满时，发送按钮显示“排队”。
  bool get queueMode => busy || slotsFull;

  bool get hasQueue => queue.isNotEmpty;

  bool get canSend =>
      connection == ConnectionStatus.ready &&
      !syncing &&
      !archived &&
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
    List<QueuedRunSummary>? queue,
    Map<String, String>? queuePreviews,
    bool? archived,
    bool? slotsFull,
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
      queue: queue ?? this.queue,
      queuePreviews: queuePreviews ?? this.queuePreviews,
      archived: archived ?? this.archived,
      slotsFull: slotsFull ?? this.slotsFull,
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
  PromptCommandCoordinator? _coordinator;
  PersistentCommandCoordinator? _persistentCommands;
  int _sequence = 0;

  @override
  ChatState build() => const ChatState();

  /// 启动时注入持久 outbox；prompt.send 先落库再发送。
  void attachPersistentCommands(PersistentCommandCoordinator coordinator) {
    _persistentCommands = coordinator;
    _coordinator = null;
  }

  /// 测试和启动流程用于注入当前会话；切换会话时重置该会话的易失状态。
  void attachSession(String sessionId) {
    if (_sessionId == sessionId) return;
    _sessionId = sessionId;
    _coordinator = null;
    state = ChatState(connection: state.connection);
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

  /// 应用一条时间线事件；队列与 activeRun 同步更新。
  void mergeEvent(TimelineEvent event) {
    final current = state.timeline ?? TimelineState.initial(event.sessionId);
    final next = applyEvent(current, event);
    final runId = event.runId;
    var queue = state.queue;
    var previews = state.queuePreviews;
    var activeRunId = state.activeRunId;
    var cancelling = state.cancelling;
    var archived = state.archived;
    RunStatus? lastRunStatus = state.lastRunStatus;

    switch (event.type) {
      case 'run.queued':
        if (runId != null && !queue.any((run) => run.runId == runId)) {
          final enqueuedAt = event.payload['enqueuedAt'];
          queue = [
            ...queue,
            QueuedRunSummary(
              runId: runId,
              commandId: '',
              enqueuedAt: enqueuedAt is int ? enqueuedAt : 0,
            ),
          ];
        }
        break;
      case 'run.started':
        if (runId != null) {
          queue = queue.where((run) => run.runId != runId).toList();
          activeRunId = runId;
        }
        break;
      case 'run.completed':
        if (runId != null) {
          queue = queue.where((run) => run.runId != runId).toList();
          previews = {...previews}..remove(runId);
        }
        if (runId == null || activeRunId == runId) activeRunId = null;
        lastRunStatus =
            RunStatus.tryParse(event.payload['status'] as String?) ??
                lastRunStatus;
        cancelling = false;
        break;
      case 'session.status':
        final eventRunId = event.payload['activeRunId'];
        if (eventRunId is String && eventRunId.isNotEmpty) {
          activeRunId = eventRunId;
        }
        if (event.payload['state'] == 'archived') archived = true;
        break;
      default:
        break;
    }

    state = state.copyWith(
      timeline: next,
      lastRunStatus: lastRunStatus,
      activeRunId: activeRunId,
      cancelling: cancelling,
      queue: queue,
      queuePreviews: previews,
      archived: archived,
    );
  }

  /// 用快照覆盖时间线、队列与全局容量。
  void mergeSnapshot(SessionSnapshot snapshot) {
    final current = state.timeline ?? TimelineState.initial('');
    final next = applySnapshot(current, snapshot);
    final remainingRunIds = snapshot.queuedRuns
        .map((run) => run.runId)
        .toSet();
    state = state.copyWith(
      timeline: next,
      snapshotTruncated: snapshot.snapshotTruncated,
      lastRunStatus: snapshot.lastRunStatus ?? state.lastRunStatus,
      activeRunId: snapshot.activeRunId,
      syncing: false,
      queue: snapshot.queuedRuns,
      queuePreviews: {
        for (final entry in state.queuePreviews.entries)
          if (remainingRunIds.contains(entry.key)) entry.key: entry.value,
      },
      archived: snapshot.sessionStatus == 'archived',
      slotsFull: snapshot.globalCapacity?.isFull ?? state.slotsFull,
    );
  }

  /// 发送当前草稿；忙碌或全局槽满时仍可发送并自动排队。
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
    final text = state.draft;
    final request = S02Commands.promptSend(
      commandId: _nextId('cmd_prompt'),
      traceId: _nextId('trace'),
      sessionId: sessionId,
      text: text,
    );
    final coordinator =
        _coordinator ??= PromptCommandCoordinator(
          client: client,
          timeout: ref.read(promptTimeoutProvider),
          persistent: _persistentCommands,
        );
    state = state.copyWith(composer: ComposerStatus.sending, error: null);
    await _executePrompt(coordinator, sessionId, request, text);
  }

  /// 结果未知时用同一 commandId 重试，不生成新命令。
  Future<void> retryUnknownCommand() async {
    final sessionId = _sessionId;
    final coordinator = _coordinator;
    if (sessionId == null || coordinator == null) return;
    state = state.copyWith(composer: ComposerStatus.sending, error: null);
    try {
      final accepted = await coordinator.retry(sessionId);
      _applyAccepted(accepted, previewText: state.draft);
    } on CommandFailure catch (error) {
      state = state.copyWith(
        composer: ComposerStatus.idle,
        error: _messageFor(error.code),
      );
    } on CommandTimeout {
      state = state.copyWith(
        composer: ComposerStatus.unknown,
        unknownCommandId: coordinator.unknownFor(sessionId)?.request.commandId,
        error: '结果未知，可用同一命令重试',
      );
    }
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

  /// 移除指定 queued run；只传目标 runId，不影响其他会话与队列。
  Future<void> removeQueuedRun(String runId) async {
    final sessionId = _sessionId;
    if (sessionId == null) return;
    final client = await ref.read(commandClientProvider.future);
    if (client == null) {
      state = state.copyWith(error: '尚未连接 Mac');
      return;
    }
    try {
      await client.execute(
        S02Commands.queueRemove(
          commandId: _nextId('cmd_remove'),
          traceId: _nextId('trace'),
          sessionId: sessionId,
          runId: runId,
        ),
      );
      state = state.copyWith(
        queue: state.queue.where((run) => run.runId != runId).toList(),
        queuePreviews: {...state.queuePreviews}..remove(runId),
        error: null,
      );
    } on CommandFailure catch (error) {
      state = state.copyWith(error: _messageFor(error.code));
    } on CommandTimeout {
      state = state.copyWith(error: '移除请求超时，请重试');
    }
  }

  /// 标记全局执行槽已满；快照会持续刷新该值。
  void setSlotsFull(bool full) {
    state = state.copyWith(slotsFull: full);
  }

  /// Agent 新实例使未确认 prompt 失效；之后必须由用户决定重试或放弃。
  void invalidateForRestart() {
    final coordinator = _coordinator;
    final sessionId = _sessionId;
    if (coordinator == null || sessionId == null) return;
    coordinator.invalidateForRestart();
    final unknown = coordinator.unknownFor(sessionId);
    if (unknown == null) return;
    state = state.copyWith(
      composer: ComposerStatus.unknown,
      unknownCommandId: unknown.request.commandId,
      error: 'Agent 已重启，请决定是否重试',
    );
  }

  Future<void> _executePrompt(
    PromptCommandCoordinator coordinator,
    String sessionId,
    CommandRequest<PromptAccepted> request,
    String text,
  ) async {
    try {
      final accepted = await coordinator.send(request);
      _applyAccepted(accepted, previewText: text);
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

  void _applyAccepted(PromptAccepted accepted, {required String previewText}) {
    final queued = accepted.status == 'queued';
    state = state.copyWith(
      draft: '',
      composer: ComposerStatus.idle,
      activeRunId: queued ? state.activeRunId : accepted.runId,
      unknownCommandId: null,
      error: null,
      queue: queued
          ? [
              ...state.queue,
              QueuedRunSummary(
                runId: accepted.runId,
                commandId: _nextId('cmd_queued'),
                enqueuedAt: DateTime.now().millisecondsSinceEpoch,
              ),
            ]
          : state.queue,
      queuePreviews: queued
          ? {...state.queuePreviews, accepted.runId: _preview(previewText)}
          : state.queuePreviews,
    );
  }

  String _preview(String text) {
    final single = text.trim().replaceAll(RegExp(r'\s+'), ' ');
    return single.length <= 40 ? single : '${single.substring(0, 40)}…';
  }

  String _blockedReason() {
    if (state.archived) return '会话已归档，只能查看';
    if (state.connection != ConnectionStatus.ready) return 'Mac 未连接';
    if (state.syncing) return '正在同步，请稍候';
    if (state.draftBytes == 0) return '请输入内容';
    return '当前不可发送';
  }

  String _messageFor(String code) {
    return switch (code) {
      'SESSION_BUSY' => '当前会话已有任务执行',
      'SESSION_ARCHIVED' => '会话已归档，只能查看',
      'QUEUE_FULL' => '队列已满，稍后再试',
      'RUN_NOT_QUEUED' => '该任务已开始，无法移除',
      'PROMPT_PENDING' => '上一条消息尚未确认，请稍后重试',
      'WORKSPACE_NOT_ALLOWED' => '项目不可用，请在本机重新授权',
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