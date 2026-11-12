import 'dart:convert';

/// 已验证的完整审批内容。
///
/// 只允许保存在内存；调用方在退后台、resolved、revoke 或 agent 实例变化时丢弃。
final class VerifiedApprovalContent {
  const VerifiedApprovalContent._({
    required this.jsonText,
    required this.data,
    required this.sha256,
  });

  /// 解析并校验外层结构；失败抛 [FormatException]。
  factory VerifiedApprovalContent.parse({
    required String jsonText,
    required String sha256,
  }) {
    final Object? decoded;
    try {
      decoded = jsonDecode(jsonText);
    } on FormatException {
      throw const FormatException('approval content is not JSON');
    }
    if (decoded is! Map) {
      throw const FormatException('approval content must be an object');
    }
    return VerifiedApprovalContent._(
      jsonText: jsonText,
      data: decoded.cast<String, Object?>(),
      sha256: sha256,
    );
  }

  final String jsonText;
  final Map<String, Object?> data;
  final String sha256;

  /// 工具名；非法时返回空串。
  String get toolName =>
      data['toolName'] is String ? data['toolName'] as String : '';

  /// 完整工作目录；非法时返回空串。
  String get workingDirectory => data['workingDirectory'] is String
      ? data['workingDirectory'] as String
      : '';

  /// 完整工具输入；非法时返回空对象。
  Map<String, Object?> get input =>
      data['input'] is Map
          ? (data['input'] as Map).cast<String, Object?>()
          : const <String, Object?>{};

  /// 展示用上下文：decisionReason / blockedPath / defaultToNo 等。
  Map<String, Object?> get context =>
      data['context'] is Map
          ? (data['context'] as Map).cast<String, Object?>()
          : const <String, Object?>{};
}