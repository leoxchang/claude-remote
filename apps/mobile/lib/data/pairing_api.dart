import 'dart:convert';

import 'package:http/http.dart' as http;

import '../features/pairing/qr_payload.dart';
import 'device_credential.dart';

/// 配对 HTTP 失败；只保留稳定错误码。
final class PairingException implements Exception {
  const PairingException(this.code);

  final String code;

  @override
  String toString() => 'PairingException($code)';
}

/// 调用 Mac 的 `/v1/pairings`；使用系统默认 TLS 校验。
final class PairingApi {
  PairingApi({
    http.Client? client,
    this.timeout = const Duration(seconds: 10),
  }) : _client = client ?? http.Client();

  /// 发送给 Mac 的 App 版本；与 pubspec 保持一致。
  static const String appVersion = '1.0.0';

  final http.Client _client;
  final Duration timeout;

  Future<DeviceCredential> pair(
    PairingQrPayload payload,
    String deviceName,
  ) async {
    final uri = Uri.parse('${payload.baseUrl}/v1/pairings');
    final http.Response response;
    try {
      response = await _client
          .post(
            uri,
            headers: const {'content-type': 'application/json'},
            body: jsonEncode({
              'pairingId': payload.pairingId,
              'code': payload.code,
              'deviceName': deviceName,
              'appVersion': appVersion,
              'supportedProtocolVersions': [PairingQrPayload.supportedVersion],
            }),
          )
          .timeout(timeout);
    } on Exception {
      throw const PairingException('DESKTOP_OFFLINE');
    }
    if (response.statusCode != 201) {
      throw PairingException(_errorCodeOf(response));
    }
    final decoded = _decode(response.body);
    final deviceId = decoded['deviceId'];
    final deviceToken = decoded['deviceToken'];
    if (deviceId is! String || deviceToken is! String) {
      throw const PairingException('PAIRING_FAILED');
    }
    final desktopId = decoded['desktopId'];
    return DeviceCredential(
      deviceId: deviceId,
      deviceToken: deviceToken,
      baseUrl: payload.baseUrl,
      desktopId: desktopId is String ? desktopId : null,
    );
  }

  Map<String, Object?> _decode(String body) {
    final Object? decoded;
    try {
      decoded = jsonDecode(body);
    } on FormatException {
      throw const PairingException('PAIRING_FAILED');
    }
    if (decoded is! Map<String, Object?>) {
      throw const PairingException('PAIRING_FAILED');
    }
    return decoded;
  }

  String _errorCodeOf(http.Response response) {
    try {
      final body = jsonDecode(response.body);
      if (body is Map) {
        final error = body['error'];
        if (error is Map && error['code'] is String) {
          return error['code'] as String;
        }
      }
    } on FormatException {
      // 响应体不是 JSON 时退回稳定错误码。
    }
    return 'PAIRING_FAILED';
  }
}