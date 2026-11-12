/// 本机保存的设备凭证；`deviceToken` 只允许写入 Keychain。
final class DeviceCredential {
  const DeviceCredential({
    required this.deviceId,
    required this.deviceToken,
    required this.baseUrl,
    this.desktopId,
  });

  /// 从 Keychain 中的 JSON 恢复；字段不全时返回 null。
  static DeviceCredential? fromJson(Object? raw) {
    if (raw is! Map<String, Object?>) return null;
    final deviceId = raw['deviceId'];
    final deviceToken = raw['deviceToken'];
    final baseUrl = raw['baseUrl'];
    if (deviceId is! String || deviceToken is! String || baseUrl is! String) {
      return null;
    }
    final desktopId = raw['desktopId'];
    return DeviceCredential(
      deviceId: deviceId,
      deviceToken: deviceToken,
      baseUrl: baseUrl,
      desktopId: desktopId is String ? desktopId : null,
    );
  }

  final String deviceId;
  final String deviceToken;
  final String baseUrl;
  final String? desktopId;

  Map<String, Object?> toJson() {
    return {
      'deviceId': deviceId,
      'deviceToken': deviceToken,
      'baseUrl': baseUrl,
      if (desktopId != null) 'desktopId': desktopId,
    };
  }

  /// 刻意隐藏 token，避免它出现在日志或错误信息里。
  @override
  String toString() => 'DeviceCredential(deviceId: $deviceId)';
}