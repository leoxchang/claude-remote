import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../../domain/approval.dart';
import '../../protocol/s03_messages.dart';
import 'approval_content_api.dart';

/// 完整内容无法通过本地校验；App 不得据此允许。
final class ContentIntegrityException implements Exception {
  const ContentIntegrityException(this.code);

  final String code;

  @override
  String toString() => 'ContentIntegrityException($code)';
}

/// 顺序读取并校验全部块；任一失败都不得进入 ready。
final class ApprovalContentLoader {
  const ApprovalContentLoader(this.api);

  final ApprovalContentApi api;

  Future<VerifiedApprovalContent> load(ApprovalSummary summary) async {
    final descriptor = summary.content;
    final parts = <String>[];
    for (var index = 0; index < descriptor.chunkCount; index += 1) {
      final chunk = await api.getChunk(summary, index);
      if (chunk.approvalId != summary.approvalId) {
        throw const ContentIntegrityException('WRONG_APPROVAL');
      }
      if (chunk.chunkIndex != index) {
        throw const ContentIntegrityException('CHUNK_ORDER');
      }
      if (chunk.chunkCount != descriptor.chunkCount) {
        throw const ContentIntegrityException('CHUNK_COUNT');
      }
      if (chunk.encoding != descriptor.encoding) {
        throw const ContentIntegrityException('ENCODING');
      }
      if (chunk.byteLength != descriptor.byteLength) {
        throw const ContentIntegrityException('BYTE_LENGTH');
      }
      if (chunk.sha256 != descriptor.sha256) {
        throw const ContentIntegrityException('HASH');
      }
      parts.add(chunk.text);
    }
    if (parts.isEmpty) {
      throw const ContentIntegrityException('CHUNK_COUNT');
    }
    final jsonText = parts.join();
    final bytes = utf8.encode(jsonText);
    if (bytes.length != descriptor.byteLength) {
      throw const ContentIntegrityException('BYTE_LENGTH');
    }
    final digest = sha256.convert(bytes);
    final encoded = base64UrlEncode(digest.bytes).replaceAll('=', '');
    if (encoded != descriptor.sha256) {
      throw const ContentIntegrityException('HASH');
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(jsonText);
    } on FormatException {
      throw const ContentIntegrityException('INVALID_JSON');
    }
    if (decoded is! Map || decoded['toolName'] is! String) {
      throw const ContentIntegrityException('INVALID_JSON');
    }
    return VerifiedApprovalContent.parse(
      jsonText: jsonText,
      sha256: descriptor.sha256,
    );
  }
}