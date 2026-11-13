import 'dart:async';

import 'package:flutter/widgets.dart' show AppLifecycleListener;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../connection/chat_session_runtime.dart';
import '../connection/command_client.dart';
import '../connection/connection_controller.dart';
import '../connection/persistent_command_coordinator.dart';
import '../connection/session_sync_coordinator.dart';
import '../features/recovery/recovery_controller.dart';
import '../features/recovery/recovery_prompt_api.dart';
import '../domain/session.dart';
import '../protocol/s04_messages.dart';
import '../protocol/decoder.dart';
import '../protocol/envelope.dart';
import '../protocol/messages.dart';
import '../voice/voice_asr_client.dart';
import '../voice/voice_audio_capture.dart';
import '../voice/voice_input_controller.dart';
import '../voice/voice_interruption_bridge.dart';
import 'recovery_providers.dart';
import '../features/approvals/approval_command_coordinator.dart';
import '../features/approvals/approval_content_api.dart';
import '../features/approvals/approval_content_loader.dart';
import '../features/approvals/approval_controller.dart';
import '../features/chat/chat_controller.dart';
import '../features/chat/session_controller.dart';
import '../features/pairing/pairing_controller.dart' show credentialStoreProvider;
import 'agent_socket.dart';
import 'device_credential.dart';
import 'io_agent_socket.dart';
import 'pairing_api.dart';

/// 启动时读取 Keychain；未配对返回 null。
final credentialProvider = FutureProvider<DeviceCredential?>((ref) async {
  return ref.watch(credentialStoreProvider).read();
});

/// 已配对环境下的命令客户端；未配对返回 null。
final commandClientProvider = FutureProvider<CommandClient?>((ref) async {
  final credential = await ref.watch(credentialProvider.future);
  if (credential == null) return null;
  return CommandClient(IoAgentSocket.connect(credential));
});

/// 审批命令专用客户端；与聊天命令分离，避免共享未完成请求。
final approvalCommandClientProvider = Provider<CommandClient>(
  (ref) => CommandClient(),
);

/// 连接就绪状态；审批只在线时允许提交。
final approvalOnlineProvider = NotifierProvider<ApprovalOnlineNotifier, bool>(
  ApprovalOnlineNotifier.new,
);

final class ApprovalOnlineNotifier extends Notifier<bool> {
  @override
  bool build() => false;

  void setOnline(bool value) => state = value;
}

/// 审批控制器；只在已配对时存在。
final approvalControllerProvider = FutureProvider<ApprovalController?>((ref) async {
  final credential = await ref.watch(credentialProvider.future);
  if (credential == null) return null;
  final client = ref.watch(approvalCommandClientProvider);
  late final ApprovalController controller;
  controller = ApprovalController(
    loader: ApprovalContentLoader(
      ApprovalContentApi(
        credentials: ref.read(credentialStoreProvider),
        transport: HttpApprovalContentTransport(),
      ),
    ),
    coordinator: ApprovalCommandCoordinator(
      client: client,
      isOnline: () => ref.read(approvalOnlineProvider),
      verifiedSha: (approvalId) =>
          controller.approvalContentCache[approvalId]?.sha256,
    ),
    isOnline: () => ref.read(approvalOnlineProvider),
  );
  ref.onDispose(controller.dispose);
  return controller;
});

/// S04 持久 outbox；prompt.send/run.requeue 先落库再发送。
final persistentCommandCoordinatorProvider =
    FutureProvider<PersistentCommandCoordinator?>((ref) async {
      final credential = await ref.watch(credentialProvider.future);
      if (credential == null) return null;
      final store = await ref.watch(recoveryStoreProvider.future);
      final client = ref.watch(approvalCommandClientProvider);
      return PersistentCommandCoordinator(
        outbox: store.outbox,
        deliver: (snapshot) => client.execute<JsonMap>(
          CommandRequest<JsonMap>(
            commandId: snapshot.commandId,
            traceId: 'trace_${snapshot.commandId}',
            type: snapshot.type,
            sessionId: snapshot.sessionId,
            runId: snapshot.payload['runId'] as String?,
            payload: snapshot.payload,
            decode: (data) => data,
          ),
        ),
      );
    });

/// 显式恢复交互；prompt 只存页面内存。
final recoveryControllerProvider = FutureProvider<RecoveryController?>((
  ref,
) async {
  final credential = await ref.watch(credentialProvider.future);
  if (credential == null) return null;
  final client = ref.watch(approvalCommandClientProvider);
  final coordinator = await ref.watch(persistentCommandCoordinatorProvider.future);
  final api = RecoveryPromptApi(
    credentials: ref.read(credentialStoreProvider),
    transport: HttpRecoveryPromptTransport(),
  );
  return RecoveryController(
    loadPromptText: api.read,
    requeueRun: (runId, sessionId, generation) async {
      final commandId = 'cmd_requeue_${DateTime.now().microsecondsSinceEpoch}';
      await coordinator!.send(
        commandId: commandId,
        sessionId: sessionId,
        type: 'run.requeue',
        payload: {
          'runId': runId,
          'expectedRecoveryGeneration': generation,
        },
      );
      await coordinator.onConfirmed(commandId);
    },
    discardRun: (runId) async {
      await client.execute<JsonMap>(
        CommandRequest<JsonMap>(
          commandId: 'cmd_discard_${DateTime.now().microsecondsSinceEpoch}',
          traceId: 'trace_discard',
          type: 'queue.remove',
          runId: runId,
          payload: const {},
          decode: (data) => data,
        ),
      );
    },
    canStartIntent: (sessionId) async =>
        await coordinator?.canStartExecutionIntent(sessionId) ?? true,
  );
});

/// S04 afterSeq 同步与分页快照；事件应用回 ChatController。
final sessionSyncCoordinatorProvider =
    FutureProvider<SessionSyncCoordinator?>((ref) async {
      final credential = await ref.watch(credentialProvider.future);
      if (credential == null) return null;
      final client = await ref.watch(commandClientProvider.future);
      if (client == null) return null;
      final store = await ref.watch(recoveryStoreProvider.future);
      final recovery = await ref.watch(recoveryControllerProvider.future);
      final chat = ref.read(chatControllerProvider.notifier);
      var sequence = 0;
      String nextCommand(String prefix) =>
          'cmd_${prefix}_${DateTime.now().microsecondsSinceEpoch}_${++sequence}';

      return SessionSyncCoordinator(
        syncPage: (afterSeq, limit) async {
          final sessionId = chat.sessionId;
          if (sessionId == null) throw StateError('session not attached');
          return client.execute<SyncPageMessage>(
            CommandRequest<SyncPageMessage>(
              commandId: nextCommand('sync'),
              traceId: nextCommand('trace'),
              type: 'session.sync',
              sessionId: sessionId,
              payload: {'afterSeq': afterSeq, 'limit': limit},
              decode: SyncPageMessage.fromWire,
            ),
          );
        },
        snapshotPage: (snapshotId, pageIndex) async {
          final sessionId = chat.sessionId;
          if (sessionId == null) throw StateError('session not attached');
          return client.execute<SnapshotPageMessage>(
            CommandRequest<SnapshotPageMessage>(
              commandId: nextCommand('snapshot'),
              traceId: nextCommand('trace'),
              type: 'session.snapshot',
              sessionId: sessionId,
              payload: {
                if (snapshotId != null) 'snapshotId': snapshotId,
                if (pageIndex != null) 'pageIndex': pageIndex,
              },
              decode: SnapshotPageMessage.fromWire,
            ),
          );
        },
        applySnapshot: (assembly) {
          final merged = <String, Object?>{...assembly.firstPage};
          merged['recentEvents'] = assembly.events
              .map((event) => event.toWire())
              .toList(growable: false);
          chat.mergeSnapshot(SessionSnapshot.fromPayload(merged));
          final runs = merged['recoveryRequiredRuns'];
          if (runs is List) {
            recovery?.registerRecoveryRuns([
              for (final entry in runs.whereType<Map<dynamic, dynamic>>())
                if (entry['runId'] is String &&
                    entry['recoveryGeneration'] is int)
                  RecoveryRunSummary(
                    runId: entry['runId'] as String,
                    sessionId: assembly.sessionId,
                    recoveryGeneration:
                        entry['recoveryGeneration'] as int,
                    promptExpiresAt: entry['promptExpiresAt'] is int
                        ? entry['promptExpiresAt'] as int
                        : null,
                  ),
            ]);
          }
          unawaited(
            store.writeCursor(
              sessionId: assembly.sessionId,
              lastContiguousSeq: assembly.lastSeq,
              lastSnapshotId: assembly.snapshotId,
            ),
          );
        },
        applyEvent: chat.mergeEvent,
        onCursor: (sessionId, lastSeq) {
          unawaited(
            store.writeCursor(
              sessionId: sessionId,
              lastContiguousSeq: lastSeq,
            ),
          );
        },
        cache: store.cache,
        onStatePage: (sessionId, page) {
          final runs = page['recoveryRequiredRuns'];
          if (runs is! List) return;
          recovery?.registerRecoveryRuns([
            for (final entry in runs.whereType<Map<dynamic, dynamic>>())
              if (entry['runId'] is String &&
                  entry['recoveryGeneration'] is int)
                RecoveryRunSummary(
                  runId: entry['runId'] as String,
                  sessionId: sessionId,
                  recoveryGeneration: entry['recoveryGeneration'] as int,
                  promptExpiresAt: entry['promptExpiresAt'] is int
                      ? entry['promptExpiresAt'] as int
                      : null,
                ),
          ]);
        },
      );
    });

/// 已配对时的聊天运行时；未配对返回 null。
final chatSessionRuntimeProvider = FutureProvider<ChatSessionRuntime?>((
  ref,
) async {
  final credential = await ref.watch(credentialProvider.future);
  if (credential == null) return null;
  final chat = ref.read(chatControllerProvider.notifier);
  final client = CommandClient();
  final session = SessionController(
    client: client,
    readSessionId: () => chat.sessionId,
    writeSessionId: chat.attachSession,
  );
  AgentSocket createSocket() => IoAgentSocket.connect(credential);
  final approvalClient = ref.watch(approvalCommandClientProvider);
  final approvals = await ref.watch(approvalControllerProvider.future);
  final persistent = await ref.watch(persistentCommandCoordinatorProvider.future);
  final recovery = await ref.watch(recoveryControllerProvider.future);
  final sync = await ref.watch(sessionSyncCoordinatorProvider.future);
  final recoveryStore = await ref.watch(recoveryStoreProvider.future);
  if (persistent != null) chat.attachPersistentCommands(persistent);
  chat.attachVoiceDrafts(recoveryStore.voiceDrafts);
  late final ConnectionController connection;
  connection = ConnectionController(
    socketFactory: createSocket,
    deviceId: credential.deviceId,
    appVersion: PairingApi.appVersion,
    onSocket: (socket) {
      unawaited(client.replaceSocket(socket));
      unawaited(approvalClient.replaceSocket(socket));
    },
    onStatus: (status) {
      chat.setConnection(status);
      ref
          .read(approvalOnlineProvider.notifier)
          .setOnline(status == ConnectionStatus.ready);
    },
    onAgentInstanceChanged: (previous, next) {
      if (previous != null && previous != next) {
        chat.invalidateForRestart();
        approvals?.onAgentInstanceChanged();
        unawaited(persistent?.onReady(next));
      }
    },
    onLifecycleHook: (state) {
      approvals?.onLifecycle(state);
      recovery?.onLifecycle(state);
    },
    onReady: () async {
      chat.setSyncing(true);
      try {
        final record = await session.startOrAttach(refresh: false);
        chat.attachSession(record.sessionId);
        if (sync != null) {
          final cursor = await recoveryStore.readCursor(record.sessionId);
          final cached = await recoveryStore.cache.readEvents(record.sessionId);
          if (cached.isNotEmpty) {
            for (final entry in cached) {
              try {
                final decoded = ProtocolDecoder.decode(entry.payloadJson);
                if (decoded is TimelineEvent) chat.mergeEvent(decoded);
              } on ProtocolDecodeException {
                // 单条缓存损坏不影响后续同步。
              }
            }
            chat.setCacheNotice(true);
          }
          sync.seedCursor(record.sessionId, cursor?.lastContiguousSeq ?? 0);
          try {
            final result = await sync.sync(record.sessionId);
            if (result.resyncRequired) {
              await sync.resyncSnapshot(record.sessionId);
            } else {
              await sync.refreshStatePage(record.sessionId);
            }
            chat.setCacheNotice(false);
          } on Object {
            chat.reportError('历史同步失败，将继续重试');
          }
        }
      } on Object {
        chat.reportError('会话建立失败');
        rethrow;
      } finally {
        chat.setSyncing(false);
      }
    },
  );
  return ChatSessionRuntime(
    connection: connection,
    session: session,
    chat: chat,
    approvals: approvals,
  );
});
/// 语音输入控制器；未配对或存储不可用时返回 null，文字输入不受影响。
final voiceInputControllerProvider =
    FutureProvider<VoiceInputController?>((ref) async {
      final credential = await ref.watch(credentialProvider.future);
      if (credential == null) return null;
      final store = await ref.watch(recoveryStoreProvider.future);
      final chat = ref.read(chatControllerProvider.notifier);
      final controller = VoiceInputController(
        clientFactory: IoVoiceAsrClientFactory(credential: credential),
        capture: RecordVoiceAudioCapture(),
        drafts: store.voiceDrafts,
        access: _ChatVoiceDraftAccess(chat),
        onPendingDraftChanged: (voiceDraftId, sessionId) => chat
            .setPendingVoiceDraft(voiceDraftId, sessionId: sessionId),
      );
      ref.onDispose(controller.dispose);
      return controller;
    });

/// 音频中断与退后台都取消当前流；结束后不自动恢复。
final voiceInterruptionProvider = Provider<void>((ref) {
  final bridge = VoiceInterruptionBridge();
  final subscription = bridge.events.listen((event) {
    if (event != VoiceInterruption.began) return;
    final controller = ref.read(voiceInputControllerProvider).value;
    if (controller != null) {
      unawaited(controller.cancel(VoiceCancelReason.interruption));
    }
  });
  final lifecycle = AppLifecycleListener(
    onHide: () => _cancelVoice(ref, VoiceCancelReason.background),
    onPause: () => _cancelVoice(ref, VoiceCancelReason.background),
  );
  ref.onDispose(() {
    lifecycle.dispose();
    unawaited(subscription.cancel());
  });
});

void _cancelVoice(Ref ref, VoiceCancelReason reason) {
  final controller = ref.read(voiceInputControllerProvider).value;
  if (controller != null) unawaited(controller.cancel(reason));
}

/// ChatController 的草稿适配；只暴露当前会话。
final class _ChatVoiceDraftAccess implements VoiceDraftAccess {
  _ChatVoiceDraftAccess(this._chat);

  final ChatController _chat;

  @override
  String get selectedSessionId => _chat.sessionId ?? '';

  @override
  String draftOf(String sessionId) =>
      sessionId == _chat.sessionId ? _chat.currentDraft : '';

  @override
  void setDraft(String sessionId, String text) {
    if (sessionId == _chat.sessionId) _chat.updateDraft(text);
  }

  @override
  void showVoiceError(String code, String safeMessage) {
    _chat.showVoiceError(safeMessage);
  }
}
