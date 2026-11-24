import 'dart:convert';

import '../../data/ip_address.dart';

/// 二维码载荷校验失败；只暴露安全 code，不回显原始载荷。
final class PairingPayloadException implements Exception {
  const PairingPayloadException(this.code);

  final String code;

  @override
  String toString() => 'PairingPayloadException($code)';
}

/// 一次性配对二维码载荷；语义见 S01 spec §8.1。
final class PairingQrPayload {
  const PairingQrPayload({
    required this.v,
    required this.baseUrl,
    required this.pairingId,
    required this.code,
    required this.expiresAt,
  });

  /// 当前唯一支持的二维码版本。
  static const int supportedVersion = 1;

  /// 校验并解析二维码原文；任何不合规输入都抛 [PairingPayloadException]。
  factory PairingQrPayload.parse(String raw, {DateTime? now}) {
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      throw const PairingPayloadException('INVALID_QR');
    }
    if (decoded is! Map<String, Object?>) {
      throw const PairingPayloadException('INVALID_QR');
    }
    if (decoded.containsKey('deviceToken') || decoded.containsKey('token')) {
      throw const PairingPayloadException('INVALID_QR');
    }
    final version = decoded['v'];
    if (version is! int) throw const PairingPayloadException('INVALID_QR');
    if (version != supportedVersion) {
      throw const PairingPayloadException('UNSUPPORTED_QR_VERSION');
    }
    final baseUrl = _requiredString(decoded, 'baseUrl');
    final uri = Uri.tryParse(baseUrl);
    if (uri == null || !_isAllowedBaseUrl(uri)) {
      throw const PairingPayloadException('INVALID_QR');
    }
    final expiresAt = decoded['expiresAt'];
    if (expiresAt is! int) throw const PairingPayloadException('INVALID_QR');
    final current = now ?? DateTime.now();
    if (expiresAt <= current.millisecondsSinceEpoch) {
      throw const PairingPayloadException('QR_EXPIRED');
    }
    return PairingQrPayload(
      v: version,
      baseUrl: baseUrl,
      pairingId: _requiredString(decoded, 'pairingId'),
      code: _requiredString(decoded, 'code'),
      expiresAt: expiresAt,
    );
  }

  final int v;
  final String baseUrl;
  final String pairingId;
  final String code;
  final int expiresAt;
}

String _requiredString(Map<String, Object?> map, String key) {
  final value = map[key];
  if (value is! String || value.isEmpty) {
    throw const PairingPayloadException('INVALID_QR');
  }
  return value;
}

/// https 任意主机；http 仅私有 IPv4（局域网直连）。
bool _isAllowedBaseUrl(Uri uri) {
  if (uri.userInfo.isNotEmpty || uri.hasQuery || uri.hasFragment) {
    return false;
  }
  if (uri.path.isNotEmpty && uri.path != '/') return false;
  if (uri.scheme == 'https') return true;
  return uri.scheme == 'http' && isPrivateIpv4(uri.host);
}

