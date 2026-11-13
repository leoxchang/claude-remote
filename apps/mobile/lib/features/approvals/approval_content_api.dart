import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../data/credential_store.dart';
import '../../protocol/s03_messages.dart';

/// 内容读取失败；code 来自 Mac 安全错误码或本地校验。
final class ApprovalContentException implements Exception {
  const ApprovalContentException(this.code);

  final String code;

  @override
  String toString() => 'ApprovalContentException($code)';
}

/// HTTP 响应子集；测试用内存实现替换真实网络。
final class ApprovalTransportResponse {
  const ApprovalTransportResponse({
    required this.statusCode,
    required this.body,
  });

  final int statusCode;
  final String body;
}

/// 可注入的 HTTP 传输。
abstract interface class ApprovalContentTransport {
  Future<ApprovalTransportResponse> get(
    Uri uri,
    Map<String, String> headers,
  );
}

/// 真实 HTTPS 传输；token 只在 Authorization header。
final class HttpApprovalContentTransport implements ApprovalContentTransport {
  HttpApprovalContentTransport({http.Client? client})
    : _client = client ?? http.Client();

  final http.Client _client;

  @override
  Future<ApprovalTransportResponse> get(
    Uri uri,
    Map<String, String> headers,
  ) async {
    final response = await _client.get(uri, headers: headers);
    return ApprovalTransportResponse(
      statusCode: response.statusCode,
      body: response.body,
    );
  }
}

/// 只读取单块审批内容；不记录 token 或正文。
final class ApprovalContentApi {
  const ApprovalContentApi({
    required this.credentials,
    required this.transport,
  });

  final CredentialStore credentials;
  final ApprovalContentTransport transport;

  Future<ApprovalContentChunk> getChunk(
    ApprovalSummary summary,
    int chunkIndex,
  ) async {
    final credential = await credentials.read();
    if (credential == null) {
      throw const ApprovalContentException('UNAUTHENTICATED');
    }
    final uri = Uri.parse(
      '${credential.baseUrl}/v1/approvals/${summary.approvalId}/content',
    ).replace(queryParameters: <String, String>{
      'chunkIndex': '$chunkIndex',
    });
    final response = await transport.get(uri, <String, String>{
      'authorization': 'Bearer ${credential.deviceId}.${credential.deviceToken}',
    });
    if (response.statusCode != 200) {
      throw ApprovalContentException(_errorCode(response.body));
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! Map) {
      throw const ApprovalContentException('INVALID_RESPONSE');
    }
    final body = decoded.cast<String, Object?>();
    final approvalId = body['approvalId'];
    final responseChunkIndex = body['chunkIndex'];
    final chunkCount = body['chunkCount'];
    final encoding = body['encoding'];
    final byteLength = body['byteLength'];
    final sha256 = body['sha256'];
    final text = body['text'];
    if (approvalId is! String ||
        responseChunkIndex is! int ||
        chunkCount is! int ||
        encoding is! String ||
        byteLength is! int ||
        sha256 is! String ||
        text is! String) {
      throw const ApprovalContentException('INVALID_RESPONSE');
    }
    return ApprovalContentChunk(
      approvalId: approvalId,
      chunkIndex: responseChunkIndex,
      chunkCount: chunkCount,
      encoding: encoding,
      byteLength: byteLength,
      sha256: sha256,
      text: text,
    );
  }

  String _errorCode(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map && decoded['error'] is Map) {
        final error = (decoded['error'] as Map).cast<String, Object?>();
        final code = error['code'];
        if (code is String && code.isNotEmpty) return code;
      }
    } on FormatException {
      return 'CONTENT_UNAVAILABLE';
    }
    return 'CONTENT_UNAVAILABLE';
  }
}