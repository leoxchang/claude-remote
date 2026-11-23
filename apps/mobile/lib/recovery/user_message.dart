/// 用户提问的本地记录；只保存在本机，不进入协议或 Mac 事件历史。
final class UserMessage {
  const UserMessage({
    required this.sessionId,
    required this.commandId,
    required this.text,
    required this.createdAt,
    this.attachmentPaths = const <String>[],
  });

  final String sessionId;

  /// 产生该提问的 `prompt.send` commandId；同一命令重试不会重复记录。
  final String commandId;

  final String text;

  /// 本机保存的图片路径；用于气泡缩略图，不参与上传。
  final List<String> attachmentPaths;

  final int createdAt;
}

/// 用户提问的本地存储接口；测试可注入内存实现。
abstract interface class UserMessageStore {
  Future<void> appendUserMessage(UserMessage message);

  /// 按发送时间升序返回；最多保留最近 200 条。
  Future<List<UserMessage>> readUserMessages(String sessionId);
}

/// 把手机临时图片复制到 App 支持目录，保证重启后仍能显示缩略图。
abstract interface class UserAttachmentStore {
  /// 返回复制后的绝对路径。
  Future<String> copyUserAttachment({
    required String commandId,
    required String sourcePath,
    required int index,
  });
}