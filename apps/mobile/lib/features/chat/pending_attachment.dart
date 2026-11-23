/// 图片来源；与 image_picker 解耦，测试可替换。
enum PhotoSource { camera, gallery }

/// 输入区里待发送的一张图片；只在前端使用。
final class PendingAttachment {
  const PendingAttachment({
    required this.localPath,
    required this.size,
    this.mediaType,
    this.attachmentId,
  });

  /// 手机本机路径；用于预览与发送后复制。
  final String localPath;

  final int size;

  /// Mac 返回的 media type；上传成功前为 null。
  final String? mediaType;

  /// Mac 生成的引用；上传成功前为 null。
  final String? attachmentId;

  bool get isReady => attachmentId != null && mediaType != null;

  PendingAttachment uploaded({
    required String attachmentId,
    required String mediaType,
    required int size,
  }) {
    return PendingAttachment(
      localPath: localPath,
      size: size,
      mediaType: mediaType,
      attachmentId: attachmentId,
    );
  }

  Map<String, Object?> toWire() {
    return {
      'attachmentId': attachmentId,
      'mediaType': mediaType,
      'size': size,
    };
  }
}