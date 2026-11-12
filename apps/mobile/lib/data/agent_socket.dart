import '../protocol/envelope.dart';

/// 命令与事件在链路上的 JSON 形态。
typedef JsonMap = Map<String, dynamic>;

/// App 与 Mac 的 WebSocket 抽象；测试用假实现替代真实 IO。
abstract interface class AgentSocket {
  Stream<String> get messages;

  Future<void> send(ProtocolMessage message);

  Future<void> close();
}