import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../connection/chat_session_runtime.dart';
import '../connection/command_client.dart';
import '../connection/connection_controller.dart';
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
  final connection = ConnectionController(
    socketFactory: createSocket,
    deviceId: credential.deviceId,
    appVersion: PairingApi.appVersion,
    onSocket: client.replaceSocket,
    onStatus: chat.setConnection,
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
  );
});