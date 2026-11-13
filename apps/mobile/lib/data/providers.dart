import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../connection/chat_session_runtime.dart';
import '../connection/command_client.dart';
import '../connection/connection_controller.dart';
import '../connection/persistent_command_coordinator.dart';
import '../features/recovery/recovery_controller.dart';
import '../features/recovery/recovery_prompt_api.dart';
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
      final wire = await coordinator!.send(
        commandId: commandId,
        sessionId: sessionId,
        type: 'run.requeue',
        payload: {
          'runId': runId,
          'expectedRecoveryGeneration': generation,
        },
      );
      if (wire['status'] == 'error') {
        throw CommandFailure('${(wire['error'] as Map)['code']}');
      }
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
  if (persistent != null) chat.attachPersistentCommands(persistent);
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
    onLifecycleHook: (state) => approvals?.onLifecycle(state),
    onReady: () async {
      chat.setSyncing(true);
      try {
        final record = await session.startOrAttach();
        chat.attachSession(record.sessionId);
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