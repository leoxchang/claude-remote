import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../data/credential_store.dart';
import '../../data/device_credential.dart';

/// run prompt 读取失败；code 来自服务端错误。
final class RecoveryPromptException implements Exception {
  const RecoveryPromptException(this.code);

  final String code;

  @override
  String toString() => 'RecoveryPromptException($code)';
}

/// 可注入的 HTTP 传输；测试不发起真实网络。
abstract interface class RecoveryPromptTransport {
  Future<http.Response> get(Uri uri, Map<String, String> headers);
}

final class HttpRecoveryPromptTransport implements RecoveryPromptTransport {
  HttpRecoveryPromptTransport([http.Client? client]) : _client = client ?? http.Client();

  final http.Client _client;

  @override
  Future<http.Response> get(Uri uri, Map<String, String> headers) {
    return _client.get(uri, headers: headers);
  }
}

/// 只读 run prompt；不缓存正文，不写本地存储。
final class RecoveryPromptApi {
  const RecoveryPromptApi({
    required this.credentials,
    required this.transport,
  });

  final CredentialStore credentials;
  final RecoveryPromptTransport transport;

  Future<String> read(String runId) async {
    final DeviceCredential? credential = await credentials.read();
    if (credential == null) throw const RecoveryPromptException('UNAUTHENTICATED');
    final uri = credential.httpUri('/v1/runs/$runId/prompt');
    final response = await transport.get(uri, <String, String>{
      'authorization': 'Bearer ${credential.deviceId}.${credential.deviceToken}',
    });
    if (response.statusCode != 200) {
      throw RecoveryPromptException(_errorCode(response.body));
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! Map || decoded['text'] is! String) {
      throw const RecoveryPromptException('INVALID_RESPONSE');
    }
    return decoded['text'] as String;
  }

  String _errorCode(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map && decoded['error'] is Map) {
        final code = (decoded['error'] as Map)['code'];
        if (code is String && code.isNotEmpty) return code;
      }
    } on FormatException {
      // 回退到稳定错误。
    }
    return 'RUN_NOT_FOUND';
  }
}