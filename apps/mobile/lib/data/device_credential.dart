/// 凭证模式：直连（扫码配对）或云端（relay 登录）。
enum ConnectionMode { direct, cloud }

/// 本机保存的设备凭证；`deviceToken` 只允许写入 Keychain。
final class DeviceCredential {
  const DeviceCredential({
    required this.deviceId,
    required this.deviceToken,
    required this.baseUrl,
    this.desktopId,
    this.mode = ConnectionMode.direct,
  });

  /// 云端存储作用域名最长截断；避免异常 deviceId 生成超长文件名。
  static const int _maxScopeIdLength = 48;

  /// 从 Keychain 中的 JSON 恢复；字段不全或模式未知时返回 null。
  static DeviceCredential? fromJson(Object? raw) {
    if (raw is! Map<String, Object?>) return null;
    final deviceId = raw['deviceId'];
    final deviceToken = raw['deviceToken'];
    final baseUrl = raw['baseUrl'];
    if (deviceId is! String || deviceToken is! String || baseUrl is! String) {
      return null;
    }
    final mode = _modeFromJson(raw['mode']);
    if (mode == null) return null;
    final desktopId = raw['desktopId'];
    return DeviceCredential(
      deviceId: deviceId,
      deviceToken: deviceToken,
      baseUrl: baseUrl,
      desktopId: desktopId is String ? desktopId : null,
      mode: mode,
    );
  }

  /// 旧凭证没有 `mode` 字段，按直连解析。
  static ConnectionMode? _modeFromJson(Object? raw) {
    return switch (raw) {
      null => ConnectionMode.direct,
      'direct' => ConnectionMode.direct,
      'cloud' => ConnectionMode.cloud,
      _ => null,
    };
  }

  final String deviceId;
  final String deviceToken;
  final String baseUrl;
  final String? desktopId;
  final ConnectionMode mode;

  /// 本地恢复库的作用域；直连沿用旧文件名，云端按 desktopId 隔离。
  String? get storageScope {
    if (mode == ConnectionMode.direct) return null;
    final desktopId = this.desktopId;
    if (desktopId == null) return 'cloud-unselected';
    final safe = desktopId.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
    final clipped = safe.length > _maxScopeIdLength
        ? safe.substring(0, _maxScopeIdLength)
        : safe;
    return 'cloud-$clipped';
  }

  /// 云端切换控制目标；身份与令牌不变。
  DeviceCredential withDesktop(String desktopId) {
    return DeviceCredential(
      deviceId: deviceId,
      deviceToken: deviceToken,
      baseUrl: baseUrl,
      desktopId: desktopId,
      mode: mode,
    );
  }

  /// WS 端点；云端模式追加 `desktopId` 查询参数（契约 §4.1）。
  Uri webSocketUri(String path) {
    final base = Uri.parse(baseUrl);
    final scheme = base.scheme == 'https' ? 'wss' : 'ws';
    return base.replace(
      scheme: scheme,
      path: path,
      queryParameters: _query(const <String, String>{}),
    );
  }

  /// HTTP 端点；云端模式把 `desktopId` 合并进 query（契约 §3.6）。
  Uri httpUri(String path, [Map<String, String> query = const {}]) {
    return Uri.parse(
      baseUrl,
    ).replace(path: path, queryParameters: _query(query));
  }

  /// 直连不追加参数；云端未选电脑时拒绝构造请求。
  Map<String, String>? _query(Map<String, String> query) {
    if (mode == ConnectionMode.direct) {
      return query.isEmpty ? null : query;
    }
    final desktopId = this.desktopId;
    if (desktopId == null || desktopId.isEmpty) {
      throw StateError('desktopId not selected');
    }
    return <String, String>{...query, 'desktopId': desktopId};
  }

  Map<String, Object?> toJson() {
    return {
      'deviceId': deviceId,
      'deviceToken': deviceToken,
      'baseUrl': baseUrl,
      'mode': mode.name,
      if (desktopId != null) 'desktopId': desktopId,
    };
  }

  /// 刻意隐藏 token，避免它出现在日志或错误信息里。
  @override
  String toString() => 'DeviceCredential(deviceId: $deviceId)';
}
