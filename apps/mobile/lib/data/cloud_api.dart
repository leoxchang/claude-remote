import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// 云端接口唯一支持的主契约版本（契约 §8）。
const int cloudContractVersion = 1;

/// 云端 REST 失败；只保留稳定错误码。
final class CloudApiException implements Exception {
  const CloudApiException(this.code);

  final String code;

  @override
  String toString() => 'CloudApiException($code)';
}

/// 登录成功的设备会话；令牌只在登录响应出现一次。
final class CloudLoginResult {
  const CloudLoginResult({
    required this.accountId,
    required this.deviceId,
    required this.deviceToken,
    required this.role,
    required this.contractVersion,
  });

  final String accountId;
  final String deviceId;
  final String deviceToken;
  final String role;
  final int contractVersion;
}

/// 账号名下的一台电脑；字段语义见契约 §3.2。
final class CloudDesktop {
  const CloudDesktop({
    required this.desktopId,
    required this.desktopName,
    required this.platform,
    required this.appVersion,
    required this.online,
    required this.lastSeenAt,
  });

  /// 解析单台电脑；缺少必需字段返回 null（该条被丢弃）。
  static CloudDesktop? fromWire(Object? raw) {
    if (raw is! Map) return null;
    final map = raw.cast<String, Object?>();
    final desktopId = map['desktopId'];
    final desktopName = map['desktopName'];
    if (desktopId is! String || desktopId.isEmpty || desktopName is! String) {
      return null;
    }
    final platform = map['platform'];
    final appVersion = map['appVersion'];
    final online = map['online'];
    final lastSeenAt = map['lastSeenAt'];
    return CloudDesktop(
      desktopId: desktopId,
      desktopName: desktopName,
      platform: platform is String ? platform : '',
      appVersion: appVersion is String ? appVersion : '',
      online: online is bool ? online : false,
      lastSeenAt: lastSeenAt is int ? lastSeenAt : null,
    );
  }

  final String desktopId;
  final String desktopName;
  final String platform;
  final String appVersion;
  final bool online;
  final int? lastSeenAt;
}

/// 规范化用户输入的云端地址：补 https、去末尾斜杠，拒绝路径与凭证。
String normalizeRelayBaseUrl(String raw) {
  final trimmed = raw.trim();
  if (trimmed.isEmpty) throw const CloudApiException('INVALID_URL');
  final withScheme = trimmed.contains('://') ? trimmed : 'https://$trimmed';
  final uri = Uri.tryParse(withScheme);
  final invalid =
      uri == null ||
      (uri.scheme != 'http' && uri.scheme != 'https') ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.path.isNotEmpty && uri.path != '/');
  if (invalid) throw const CloudApiException('INVALID_URL');
  return Uri(
    scheme: uri.scheme,
    host: uri.host,
    port: uri.hasPort ? uri.port : null,
  ).toString();
}

/// 云端 REST 客户端；端点与错误码见 `protocol/v1/relay-contract.md` §3。
final class CloudApi {
  CloudApi({
    http.Client? client,
    this.timeout = const Duration(seconds: 15),
  }) : _client = client ?? http.Client();

  static const String _loginPath = '/v1/auth/login';
  static const String _desktopsPath = '/v1/desktops';
  static const String _devicesPath = '/v1/devices';

  final http.Client _client;
  final Duration timeout;

  /// 登录并注册一台手机设备（契约 §3.1）。
  Future<CloudLoginResult> login({
    required String baseUrl,
    required String username,
    required String password,
    required String deviceName,
    required String platform,
    required String appVersion,
  }) async {
    final base = normalizeRelayBaseUrl(baseUrl);
    final response = await _send(
      () => _client.post(
        Uri.parse('$base$_loginPath'),
        headers: const {'content-type': 'application/json'},
        body: jsonEncode({
          'username': username,
          'password': password,
          'clientType': 'phone',
          'deviceName': deviceName,
          'platform': platform,
          'appVersion': appVersion,
        }),
      ),
    );
    if (response.statusCode != 200) {
      throw CloudApiException(_errorCodeOf(response));
    }
    final body = _decodeObject(response.body);
    final version = body['contractVersion'];
    if (version is! int) throw const CloudApiException('INVALID_RESPONSE');
    if (version != cloudContractVersion) {
      throw const CloudApiException('VERSION_INCOMPATIBLE');
    }
    final role = _requiredString(body, 'role');
    if (role != 'phone') throw const CloudApiException('INVALID_RESPONSE');
    return CloudLoginResult(
      accountId: _requiredString(body, 'accountId'),
      deviceId: _requiredString(body, 'deviceId'),
      deviceToken: _requiredString(body, 'deviceToken'),
      role: role,
      contractVersion: version,
    );
  }

  /// 账号名下的电脑列表（契约 §3.2）；畸形条目丢弃。
  Future<List<CloudDesktop>> listDesktops({
    required String baseUrl,
    required String deviceId,
    required String deviceToken,
  }) async {
    final base = normalizeRelayBaseUrl(baseUrl);
    final response = await _send(
      () => _client.get(
        Uri.parse('$base$_desktopsPath'),
        headers: _bearer(deviceId, deviceToken),
      ),
    );
    if (response.statusCode != 200) {
      throw CloudApiException(_errorCodeOf(response));
    }
    final body = _decodeObject(response.body);
    final rawDesktops = body['desktops'];
    if (rawDesktops is! List) {
      throw const CloudApiException('INVALID_RESPONSE');
    }
    final desktops = <CloudDesktop>[];
    for (final entry in rawDesktops) {
      final desktop = CloudDesktop.fromWire(entry);
      if (desktop != null) desktops.add(desktop);
    }
    return desktops;
  }

  /// 吊销一台设备（含自己）；成功返回 204（契约 §3.4）。
  Future<void> revokeDevice({
    required String baseUrl,
    required String deviceId,
    required String deviceToken,
    required String targetDeviceId,
  }) async {
    final base = normalizeRelayBaseUrl(baseUrl);
    final response = await _send(
      () => _client.delete(
        Uri.parse(
          '$base$_devicesPath/${Uri.encodeComponent(targetDeviceId)}',
        ),
        headers: _bearer(deviceId, deviceToken),
      ),
    );
    if (response.statusCode != 204) {
      throw CloudApiException(_errorCodeOf(response));
    }
  }

  Map<String, String> _bearer(String deviceId, String deviceToken) {
    return {'Authorization': 'Bearer $deviceId.$deviceToken'};
  }

  /// 网络/传输层失败统一为 `NETWORK`，不泄露请求内容。
  Future<http.Response> _send(Future<http.Response> Function() run) async {
    try {
      return await run().timeout(timeout);
    } on TimeoutException {
      throw const CloudApiException('NETWORK');
    } on http.ClientException {
      throw const CloudApiException('NETWORK');
    }
  }

  Map<String, Object?> _decodeObject(String body) {
    final Object? decoded;
    try {
      decoded = jsonDecode(body);
    } on FormatException {
      throw const CloudApiException('INVALID_RESPONSE');
    }
    if (decoded is! Map) throw const CloudApiException('INVALID_RESPONSE');
    return decoded.cast<String, Object?>();
  }

  String _requiredString(Map<String, Object?> body, String key) {
    final value = body[key];
    if (value is! String || value.isEmpty) {
      throw const CloudApiException('INVALID_RESPONSE');
    }
    return value;
  }

  /// 错误体里的稳定码优先；响应体不是契约形状时退回 `REQUEST_FAILED`。
  String _errorCodeOf(http.Response response) {
    try {
      final body = _decodeObject(response.body);
      final error = body['error'];
      if (error is Map) {
        final code = error['code'];
        if (code is String && code.isNotEmpty) return code;
      }
    } on CloudApiException {
      // 非契约错误体。
    }
    return 'REQUEST_FAILED';
  }
}
