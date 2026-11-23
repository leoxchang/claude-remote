import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:sqflite/sqflite.dart';

import '../../connection/command_client.dart';
import '../../connection/connection_controller.dart';
import '../../connection/persistent_command_coordinator.dart';
import '../../data/agent_socket.dart';
import '../../data/attachment_upload.dart';
import '../../data/providers.dart' show commandClientProvider;
import '../../domain/run.dart';
import '../../domain/session.dart';
import '../../domain/timeline.dart';
import '../../protocol/messages.dart';
import '../../protocol/s02_messages.dart';
import '../../recovery/user_message.dart';
import '../../voice/composer_draft_store.dart';
import '../../voice/voice_draft_repository.dart';
import 'pending_attachment.dart';
import 'prompt_command_coordinator.dart';

/// S01 单条 prompt 的 UTF-8 字节上限。
const int maxPromptBytes = 16384;

/// 单条 prompt 最多附带的图片数；与 Mac 端白名单一致。
const int maxAttachmentsPerPrompt = 4;

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
    this.cacheNotice = false,
    this.pendingVoiceDraftId,
    this.pendingVoiceSessionId,
    this.userMessages = const <UserMessage>[],
    this.attachments = const <PendingAttachment>[],
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
  /// 冷启动展示本地缓存时提示“可能不是最新”。
  final bool cacheNotice;

  /// 尚未被普通发送消费的 voice draft。
  final String? pendingVoiceDraftId;
  final String? pendingVoiceSessionId;

  /// 本机保存的用户提问；只用于展示，不进入协议时间线。
  final List<UserMessage> userMessages;

  /// 已选待发送的图片；上传完成前不允许发送。
  final List<PendingAttachment> attachments;

  int get draftBytes => utf8.encode(draft).length;

  bool get busy => activeRunId != null;

  bool get hasAttachments => attachments.isNotEmpty;

  bool get attachmentsReady =>
      attachments.every((item) => item.isReady);

  bool get hasContent => draftBytes > 0 || attachments.isNotEmpty;

  /// 有活跃 run 或全局槽已满时，发送按钮显示“排队”。
  bool get queueMode => busy || slotsFull;

  bool get hasQueue => queue.isNotEmpty;

  bool get canSend =>
      connection == ConnectionStatus.ready &&
      !syncing &&
      !archived &&
      composer == ComposerStatus.idle &&
      hasContent &&
      attachmentsReady &&
      draftBytes <= maxPromptBytes;

  /// 语音输入不要求已有草稿；只要求在线、未归档且 composer 空闲。
  bool get canRecordVoice =>
      connection == ConnectionStatus.ready &&
      !syncing &&
      !archived &&
      composer == ComposerStatus.idle;

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
    bool? cacheNotice,
    Object? pendingVoiceDraftId = _unset,
    Object? pendingVoiceSessionId = _unset,
    List<UserMessage>? userMessages,
    List<PendingAttachment>? attachments,
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
      cacheNotice: cacheNotice ?? this.cacheNotice,
      pendingVoiceDraftId: identical(pendingVoiceDraftId, _unset)
          ? this.pendingVoiceDraftId
          : pendingVoiceDraftId as String?,
      pendingVoiceSessionId: identical(pendingVoiceSessionId, _unset)
          ? this.pendingVoiceSessionId
          : pendingVoiceSessionId as String?,
      userMessages: userMessages ?? this.userMessages,
      attachments: attachments ?? this.attachments,
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
  VoiceDraftStore? _voiceDrafts;
  ComposerDraftStore? _composerDrafts;
  UserMessageStore? _userMessages;
  Future<UploadedAttachment> Function(String path)? _uploadAttachment;
  UserAttachmentStore? _userAttachments;
  Future<void> _draftWrites = Future<void>.value();
  int _sequence = 0;

  @override
  ChatState build() => const ChatState();

  /// 当前附加的会话；语音草稿归属判断使用。
  String? get attachedSessionId => _sessionId;

  /// 当前编辑中的草稿文本。
  String get currentDraft => state.draft;

  /// 启动时注入持久 outbox；prompt.send 先落库再发送。
  void attachPersistentCommands(PersistentCommandCoordinator coordinator) {
    _persistentCommands = coordinator;
    _coordinator = null;
  }

  /// 语音草稿与 Composer 的桥；未装配时普通文字发送不受影响。
  void attachVoiceDrafts(VoiceDraftStore drafts) {
    _voiceDrafts = drafts;
  }

  /// 普通 Composer 草稿持久化；用于重启恢复与 voice final 冲突检测。
  void attachComposerDrafts(ComposerDraftStore drafts) {
    _composerDrafts = drafts;
  }

  /// 本地用户提问记录；未装配时只在内存显示。
  ///
  /// 注入可能晚于 attachSession（会话列表先附着、聊天页后才建 runtime），
  /// 因此这里要在已有会话时补一次恢复。
  void attachUserMessages(UserMessageStore store) {
    _userMessages = store;
    final sessionId = _sessionId;
    if (sessionId != null) unawaited(_restoreUserMessages(sessionId));
  }

  /// 图片上传入口；未装配时不能选图。
  void attachAttachmentUploader(
    Future<UploadedAttachment> Function(String path) upload,
  ) {
    _uploadAttachment = upload;
  }

  /// 提问图片的本地留存；未装配时发送后只保留内存预览。
  void attachUserAttachmentStore(UserAttachmentStore store) {
    _userAttachments = store;
  }

  /// 选中的图片立即上传；失败就从待发送列表移除并提示。
  Future<void> addImage(String localPath) async {
    if (state.attachments.any((item) => item.localPath == localPath)) return;
    if (state.attachments.length >= maxAttachmentsPerPrompt) {
      state = state.copyWith(error: '最多只能附加 $maxAttachmentsPerPrompt 张图片');
      return;
    }
    final upload = _uploadAttachment;
    if (upload == null) {
      state = state.copyWith(error: '当前无法上传图片');
      return;
    }
    int size;
    try {
      size = await File(localPath).length();
    } on FileSystemException {
      state = state.copyWith(error: '无法读取所选图片');
      return;
    }
    state = state.copyWith(
      attachments: [
        ...state.attachments,
        PendingAttachment(localPath: localPath, size: size),
      ],
      error: null,
    );
    try {
      final uploaded = await upload(localPath);
      final removedWhileUploading = !state.attachments.any(
        (item) => item.localPath == localPath,
      );
      if (removedWhileUploading) return;
      state = state.copyWith(
        attachments: state.attachments
            .map(
              (item) => item.localPath == localPath
                  ? item.uploaded(
                      attachmentId: uploaded.attachmentId,
                      mediaType: uploaded.mediaType,
                      size: uploaded.size,
                    )
                  : item,
            )
            .toList(growable: false),
      );
    } on Object {
      state = state.copyWith(
        attachments: state.attachments
            .where((item) => item.localPath != localPath)
            .toList(growable: false),
        error: '图片上传失败，请重试',
      );
    }
  }

  /// 移除一张待发送图片；上传中的移除结果会被忽略。
  void removeImage(String localPath) {
    state = state.copyWith(
      attachments: state.attachments
          .where((item) => item.localPath != localPath)
          .toList(growable: false),
    );
  }

  /// final 写入草稿后标记待消费的 voice draft；发送成功才清空。
  void setPendingVoiceDraft(String? voiceDraftId, {String? sessionId}) {
    state = state.copyWith(
      pendingVoiceDraftId: voiceDraftId,
      pendingVoiceSessionId: voiceDraftId == null ? null : sessionId,
    );
  }

  /// 恢复原草稿并删除 pending voice draft；不产生 prompt。
  Future<void> discardPendingVoiceDraft() async {
    final voiceDraftId = state.pendingVoiceDraftId;
    final drafts = _voiceDrafts;
    if (voiceDraftId == null || drafts == null) return;
    final row = await drafts.find(voiceDraftId);
    await drafts.restoreOriginal(voiceDraftId);
    setPendingVoiceDraft(null);
    if (row != null && row.originSessionId == _sessionId) {
      updateDraft(row.originalDraft);
    }
  }

  /// 测试和启动流程用于注入当前会话；切换会话时重置该会话的易失状态。
  void attachSession(String sessionId) {
    if (_sessionId == sessionId) {
      // 重新进入同一会话时不重置状态，但仍从本机存储补回提问记录。
      unawaited(_restoreUserMessages(sessionId));
      return;
    }
    _sessionId = sessionId;
    _coordinator = null;
    state = ChatState(connection: state.connection);
    unawaited(_restoreDraft(sessionId));
    unawaited(_restoreUserMessages(sessionId));
  }

  /// 当前本地会话；未附着时为 null。
  String? get sessionId => _sessionId;

  /// 冷启动缓存提示；同步完成后清除。
  void setCacheNotice(bool value) {
    state = state.copyWith(cacheNotice: value);
  }

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
    final store = _composerDrafts;
    final sessionId = _sessionId;
    final voiceDraftId = state.pendingVoiceDraftId;
    final voiceSessionId = state.pendingVoiceSessionId;
    final voiceDrafts = _voiceDrafts;
    if (store == null || sessionId == null) return;
    _draftWrites = _draftWrites.then((_) async {
      await store.saveDraft(sessionId, draft);
      if (voiceDraftId != null &&
          voiceSessionId == sessionId &&
          voiceDrafts != null) {
        await voiceDrafts.updateCombinedDraft(voiceDraftId, draft);
      }
    });
  }

  /// 语音错误的安全提示；不改变草稿与发送能力。
  void showVoiceError(String safeMessage) {
    state = state.copyWith(error: safeMessage);
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
    final attachments = state.attachments;
    final request = S02Commands.promptSend(
      commandId: _nextId('cmd_prompt'),
      traceId: _nextId('trace'),
      sessionId: sessionId,
      text: text,
      attachments: [
        for (final attachment in attachments) attachment.toWire(),
      ],
    );
    final attachmentPaths = await _copyAttachments(
      request.commandId,
      attachments,
    );
    unawaited(
      _recordUserMessage(
        UserMessage(
          sessionId: sessionId,
          commandId: request.commandId,
          text: text,
          attachmentPaths: attachmentPaths,
          createdAt: DateTime.now().millisecondsSinceEpoch,
        ),
      ),
    );
    final coordinator =
        _coordinator ??= PromptCommandCoordinator(
          client: client,
          timeout: ref.read(promptTimeoutProvider),
          persistent: _persistentCommands,
        );
    state = state.copyWith(composer: ComposerStatus.sending, error: null);
    await _executePrompt(
      coordinator,
      sessionId,
      request,
      text,
      voiceDraftId: state.pendingVoiceSessionId == sessionId
          ? state.pendingVoiceDraftId
          : null,
    );
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

  /// 发送前把临时图片复制到支持目录；失败时退回原路径，不阻断发送。
  Future<List<String>> _copyAttachments(
    String commandId,
    List<PendingAttachment> attachments,
  ) async {
    if (attachments.isEmpty) return const <String>[];
    final store = _userAttachments;
    if (store == null) {
      return attachments.map((item) => item.localPath).toList(growable: false);
    }
    final paths = <String>[];
    for (var index = 0; index < attachments.length; index += 1) {
      final attachment = attachments[index];
      try {
        paths.add(
          await store.copyUserAttachment(
            commandId: commandId,
            sourcePath: attachment.localPath,
            index: index,
          ),
        );
      } on Object {
        paths.add(attachment.localPath);
      }
    }
    return paths;
  }

  Future<void> _restoreUserMessages(String sessionId) async {
    final store = _userMessages;
    if (store == null) return;
    final messages = await store.readUserMessages(sessionId);
    if (_sessionId != sessionId) return;
    state = state.copyWith(userMessages: messages);
  }

  /// 本地回显用户提问；同一 commandId 只记录一次。
  Future<void> _recordUserMessage(UserMessage message) async {
    if (state.userMessages.any(
      (existing) => existing.commandId == message.commandId,
    )) {
      return;
    }
    state = state.copyWith(userMessages: [...state.userMessages, message]);
    await _userMessages?.appendUserMessage(message);
  }

  Future<void> _restoreDraft(String sessionId) async {
    final store = _composerDrafts;
    if (store != null) {
      final text = await store.readDraft(sessionId);
      if (_sessionId != sessionId) return;
      if (text != null && text.isNotEmpty && state.draft.isEmpty) {
        state = state.copyWith(draft: text);
      }
    }
    final drafts = _voiceDrafts;
    if (drafts == null) return;
    final pending = await drafts.pendingForSession(sessionId);
    if (_sessionId != sessionId) return;
    if (pending.isEmpty) return;
    final latest = pending.last;
    state = state.copyWith(
      pendingVoiceDraftId: latest.voiceDraftId,
      pendingVoiceSessionId: sessionId,
    );
  }

  Future<void> _executePrompt(
    PromptCommandCoordinator coordinator,
    String sessionId,
    CommandRequest<PromptAccepted> request,
    String text, {
    String? voiceDraftId,
  }) async {
    final drafts = _voiceDrafts;
    final hook = voiceDraftId == null || drafts == null
        ? null
        : (Transaction txn) => drafts.deleteWithin(txn, voiceDraftId);
    try {
      final accepted = await coordinator.send(
        request,
        withinTransaction: hook,
      );
      if (voiceDraftId != null) {
        setPendingVoiceDraft(null);
      }
      final store = _composerDrafts;
      if (store != null) {
        _draftWrites = _draftWrites.then((_) => store.clearDraft(sessionId));
      }
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
    // 服务端事件可能先于命令结果到达：run.queued 已经加过队列项，
    // 或者 run.started 已经把该 run 变成活跃 run，这里不能重复追加。
    final alreadyKnown =
        state.queue.any((run) => run.runId == accepted.runId) ||
        state.activeRunId == accepted.runId;
    state = state.copyWith(
      draft: '',
      attachments: const <PendingAttachment>[],
      composer: ComposerStatus.idle,
      activeRunId: queued ? state.activeRunId : accepted.runId,
      unknownCommandId: null,
      error: null,
      queue: queued && !alreadyKnown
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
    if (text.trim().isEmpty) return '[图片]';
    final single = text.trim().replaceAll(RegExp(r'\s+'), ' ');
    return single.length <= 40 ? single : '${single.substring(0, 40)}…';
  }

  String _blockedReason() {
    if (state.archived) return '会话已归档，只能查看';
    if (state.connection != ConnectionStatus.ready) return 'Mac 未连接';
    if (state.syncing) return '正在同步，请稍候';
    if (state.hasAttachments && !state.attachmentsReady) return '图片上传中，请稍候';
    if (!state.hasContent) return '请输入内容或选择图片';
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