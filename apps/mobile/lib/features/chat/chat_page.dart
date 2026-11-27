import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../connection/chat_session_runtime.dart';
import '../../connection/command_client.dart';
import '../../data/providers.dart';
import '../../domain/model_option.dart';
import '../../protocol/s03_messages.dart';
import '../../voice/voice_input_controller.dart';
import '../../voice/voice_ui_state.dart';
import '../approvals/approval_controller.dart';
import '../approvals/approval_detail_page.dart';
import '../recovery/recovery_page.dart';
import 'chat_controller.dart';
import 'pending_attachment.dart';
import 'widgets/composer.dart';
import 'widgets/message_list.dart';
import 'widgets/model_picker_sheet.dart';
import 'widgets/pending_approval_card.dart';
import 'widgets/queue_panel.dart';
import 'widgets/run_controls.dart';
import 'voice_draft_banner.dart';
import 'voice_recording_panel.dart';

/// S01 唯一聊天页：时间线、停止控制和 composer。
class ChatPage extends ConsumerStatefulWidget {
  const ChatPage({super.key});

  static const String routeName = '/chat';

  @override
  ConsumerState<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends ConsumerState<ChatPage>
    with WidgetsBindingObserver {
  final TextEditingController _text = TextEditingController();
  ChatSessionRuntime? _runtime;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_startRuntime());
  }

  /// 拍照或从相册取图；统一缩到长边 1568 像素并压缩，控制上传体积。
  Future<void> _pickImage(PhotoSource source) async {
    final picker = ImagePicker();
    try {
      final XFile? file = await picker.pickImage(
        source: source == PhotoSource.camera
            ? ImageSource.camera
            : ImageSource.gallery,
        maxWidth: 1568,
        maxHeight: 1568,
        imageQuality: 82,
      );
      if (file == null) return;
      await ref.read(chatControllerProvider.notifier).addImage(file.path);
    } on Object {
      // 模拟器没有相机，或其权限被拒绝；只用相册也能发图。
      if (!mounted) return;
      ref
          .read(chatControllerProvider.notifier)
          .reportError('无法打开相机或相册');
    }
  }

  Future<void> _startRuntime() async {
    try {
      final runtime = await ref.read(chatSessionRuntimeProvider.future);
      if (!mounted) return;
      _runtime = runtime;
      await runtime?.start();
    } on Object {
      if (mounted) {
        ref.read(chatControllerProvider.notifier).reportError('无法建立与 Mac 的连接');
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _runtime?.connection.onLifecycle(state);
  }

  /// 打开模型选择面板；归档会话在点击时不响应。
  /// 清单加载中显示进度提示；旧 Agent 提示升级；其余失败允许重试拉取清单。
  Future<void> _showModelPicker() async {
    final state = ref.read(chatControllerProvider);
    if (state.archived) return;
    final controller = ref.read(chatControllerProvider.notifier);
    final workspaceId = state.workspaceId;
    if (workspaceId == null) {
      await _showCatalogNotice('模型清单获取失败');
      return;
    }
    final AsyncValue<ModelCatalog> catalog = ref.read(
      modelCatalogProvider(workspaceId),
    );
    // Riverpod 3 失败后自动重试期间状态是 AsyncLoading 且仍带 error；
    // 因此先看 error 再看 isLoading，避免把旧 Agent 的拒绝误判为加载中。
    final error = catalog.error;
    if (error is CommandFailure && error.code == 'UNKNOWN_MESSAGE_TYPE') {
      await _showCatalogNotice('Mac 端版本过旧，请升级后重试');
      return;
    }
    if (error != null) {
      await _showCatalogNotice(
        '模型清单获取失败',
        retry: () => ref.invalidate(modelCatalogProvider(workspaceId)),
      );
      return;
    }
    if (catalog.isLoading) {
      await _showCatalogNotice('正在获取模型清单…');
      return;
    }
    final models = catalog.value?.models;
    if (models == null) {
      await _showCatalogNotice(
        '模型清单获取失败',
        retry: () => ref.invalidate(modelCatalogProvider(workspaceId)),
      );
      return;
    }
    final selected = state.model;
    await showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => ModelPickerSheet(
        models: models,
        selected: selected,
        onSelect: controller.setSessionModel,
      ),
    );
  }

  Future<void> _showCatalogNotice(
    String message, {
    void Function()? retry,
  }) async {
    await showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(message),
            ),
            if (retry != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: TextButton(
                  onPressed: () {
                    Navigator.of(sheetContext).pop();
                    retry();
                  },
                  child: const Text('重试'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    // runtime 由 chatSessionRuntimeProvider 单例持有（与电脑的连接全 App 只有一条）；
    // 页面离开只停止使用，销毁交给 provider 的 onDispose（凭证/电脑切换时）。
    _runtime = null;
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(chatControllerProvider);
    final controller = ref.read(chatControllerProvider.notifier);
    final timeline = state.timeline;
    final approvals = ref.watch(approvalControllerProvider).value;
    final recovery = ref.watch(recoveryControllerProvider).value;
    final sessionId = controller.sessionId;
    final workspaceId = state.workspaceId;
    // 有 workspace 时拉取模型清单；chip 显示名优先取目录。
    final catalog = workspaceId == null
        ? null
        : ref.watch(modelCatalogProvider(workspaceId));
    ref.watch(voiceInterruptionProvider);
    final voice = ref.watch(voiceInputControllerProvider).value;
    // 语音 final 写回 ChatState.draft 后同步到输入框，保持唯一文本来源。
    if (_text.text != state.draft) {
      _text.value = TextEditingValue(
        text: state.draft,
        selection: TextSelection.collapsed(offset: state.draft.length),
      );
    }
    Widget composer({
      required bool enabled,
      bool readOnly = false,
      VoiceUiState? voiceState,
      bool canRecordVoice = false,
    }) {
      return Composer(
        controller: _text,
        enabled: enabled,
        readOnly: readOnly,
        label: state.queueMode ? '排队' : '发送',
        onChanged: controller.updateDraft,
        onSend: () async {
          await controller.sendText();
          if (!mounted) return;
          if (ref.read(chatControllerProvider).draft.isEmpty) {
            _text.clear();
          }
        },
        attachments: state.attachments,
        attachmentsBusy: state.hasAttachments && !state.attachmentsReady,
        onRemoveAttachment: controller.removeImage,
        onPickImage: (source) => unawaited(_pickImage(source)),
        voiceState: voiceState,
        canRecordVoice: canRecordVoice,
        onVoicePress: voice == null ? null : () => unawaited(voice.press()),
        onVoiceRelease: voice == null ? null : () => unawaited(voice.release()),
        onVoiceCancel: voice == null
            ? null
            : () => unawaited(voice.cancel(VoiceCancelReason.user)),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('Claude Remote'),
        actions: [
          ActionChip(
            key: const Key('modelChip'),
            tooltip: '会话模型',
            label: Text(_modelChipLabel(state, catalog?.value)),
            onPressed: () => unawaited(_showModelPicker()),
          ),
          if (recovery != null && recovery.runs.isNotEmpty)
            IconButton(
              key: const Key('recoveryButton'),
              tooltip: '待恢复任务',
              icon: const Badge(
                label: Text('!'),
                child: Icon(Icons.restore),
              ),
              onPressed: () {
                Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => RecoveryPage(controller: recovery),
                  ),
                );
              },
            ),
        ],
      ),
      body: Column(
        children: [
          if (state.cacheNotice)
            const _Banner(message: '正在显示本地缓存，可能不是最新'),
          if (state.snapshotTruncated)
            const _Banner(message: '仅保留最近摘要，完整记录暂不可下载'),
          if (state.error != null) _ErrorBar(message: state.error!),
          Expanded(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => FocusScope.of(context).unfocus(),
              child: MessageList(
                messages: timeline?.messages ?? const [],
                tools: timeline?.tools ?? const [],
                thinkings: timeline?.thinkings ?? const [],
                userMessages: state.userMessages,
              ),
            ),
          ),
          if (approvals != null && sessionId != null)
            _ApprovalCards(controller: approvals, sessionId: sessionId),
          if (state.composer == ComposerStatus.unknown)
            TextButton(
              onPressed: controller.retryUnknownCommand,
              child: const Text('结果未知，重试上一条'),
            ),
          QueuePanel(
            queue: state.queue,
            previews: state.queuePreviews,
            onRemove: (runId) => unawaited(controller.removeQueuedRun(runId)),
          ),
          RunControls(
            busy: state.busy,
            cancelling: state.cancelling,
            onStop: controller.cancelActiveRun,
          ),
          if (voice == null || sessionId == null)
            composer(enabled: state.canSend)
          else
            StreamBuilder<VoiceUiState>(
              stream: voice.states,
              initialData: voice.state,
              builder: (context, snapshot) {
                final voiceState = snapshot.data ?? const VoiceIdle();
                final locked =
                    voice.holdsOriginSession &&
                    voice.originSessionId == sessionId;
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (voiceState is VoiceRecording)
                      VoiceRecordingPanel(recording: voiceState),
                    if (voiceState is VoiceFinalizing)
                      const _Banner(message: '正在完成识别…'),
                    if (voiceState is VoiceErrorState)
                      _ErrorBar(message: voiceErrorMessage(voiceState)),
                    if (locked)
                      const _Banner(message: '正在录音，完成后可编辑'),
                    if (state.pendingVoiceDraftId != null)
                      VoiceDraftBanner(
                        message: state.pendingVoiceSessionId == sessionId
                            ? '本次语音已追加到当前草稿'
                            : '语音草稿已写入会话 ${state.pendingVoiceSessionId}',
                        onDiscard: () =>
                            unawaited(controller.discardPendingVoiceDraft()),
                      ),
                    composer(
                      enabled: state.canSend && !locked,
                      readOnly: locked,
                      voiceState: voiceState,
                      canRecordVoice: state.canRecordVoice,
                    ),
                  ],
                );
              },
            ),
        ],
      ),
    );
  }
}

/// chip 文案：null 跟随 Mac 默认显示“默认”，目录拿不到时显示原始值。
String _modelChipLabel(ChatState state, ModelCatalog? catalog) {
  final model = state.model;
  if (model == null) return '默认';
  for (final option in catalog?.models ?? const <ModelOption>[]) {
    if (option.value == model) return option.displayName;
  }
  return model;
}

/// 语音错误只显示固定安全文案。
String voiceErrorMessage(VoiceErrorState state) {
  switch (state.code) {
    case 'ASR_PERMISSION_DENIED':
      return '未获得麦克风权限，可继续文字输入';
    case 'ASR_MIC_UNAVAILABLE':
      return '麦克风不可用，可继续文字输入';
    case 'ASR_INTERRUPTED':
      return '录音被中断，请重新按住说话';
    case 'ASR_NOT_CONFIGURED':
      return '语音识别未配置，可继续文字输入';
    case 'ASR_DRAFT_CONFLICT':
      return '草稿已被修改，请手动确认是否追加';
    default:
      return '语音识别失败：${state.safeMessage}';
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: Theme.of(context).colorScheme.secondaryContainer,
      padding: const EdgeInsets.all(8),
      child: Text(message, textAlign: TextAlign.center),
    );
  }
}

class _ErrorBar extends StatelessWidget {
  const _ErrorBar({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: Theme.of(context).colorScheme.errorContainer,
      padding: const EdgeInsets.all(8),
      child: Text(message, textAlign: TextAlign.center),
    );
  }
}

/// 当前会话的待审批卡片；点击进入详情，不改变会话选择。
class _ApprovalCards extends StatelessWidget {
  const _ApprovalCards({required this.controller, required this.sessionId});

  final ApprovalController controller;
  final String sessionId;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final pending = controller.pendingForSession(sessionId);
        if (pending.isEmpty) return const SizedBox.shrink();
        return Column(
          children: [
            for (final summary in pending)
              PendingApprovalCard(
                approval: summary,
                onTap: () => _open(context, summary),
              ),
          ],
        );
      },
    );
  }

  void _open(BuildContext context, ApprovalSummary summary) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            ApprovalDetailPage(controller: controller, summary: summary),
      ),
    );
  }
}