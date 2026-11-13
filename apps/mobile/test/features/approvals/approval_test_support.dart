import 'dart:convert';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/data/agent_socket.dart';
import 'package:claude_remote/data/credential_store.dart';
import 'package:claude_remote/data/device_credential.dart';
import 'package:claude_remote/features/approvals/approval_content_api.dart';
import 'package:claude_remote/protocol/s03_messages.dart';
import 'package:crypto/crypto.dart';

/// 内存 Keychain。
final class MemoryVault implements KeyValueVault {
  MemoryVault([Map<String, String>? seed]) : values = <String, String>{...?seed};

  final Map<String, String> values;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

CredentialStore credentialStore() {
  final store = CredentialStore(MemoryVault());
  return store;
}

/// 已配对的内存 Keychain；审批内容接口要求有效设备凭证。
CredentialStore pairedCredentialStore() {
  return CredentialStore(
    MemoryVault(<String, String>{
      CredentialStore.credentialKey: jsonEncode(
        const DeviceCredential(
          deviceId: 'device_01',
          deviceToken: 'token',
          baseUrl: 'https://macbook.example-tailnet.ts.net',
        ).toJson(),
      ),
    }),
  );
}

/// 拆分 UTF-8 文本为不超过 maxBytes 的块，不切断字符。
List<String> splitUtf8(String text, int maxBytes) {
  final chunks = <String>[];
  var current = '';
  var bytes = 0;
  for (final rune in text.runes) {
    final char = String.fromCharCode(rune);
    final charBytes = utf8.encode(char).length;
    if (bytes + charBytes > maxBytes) {
      chunks.add(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += charBytes;
  }
  if (current.isNotEmpty) chunks.add(current);
  return chunks;
}

String sha256Base64Url(String text) {
  final digest = sha256.convert(utf8.encode(text));
  return base64UrlEncode(digest.bytes).replaceAll('=', '');
}

String approvalJson({String command = 'echo S03_ALPHA'}) {
  return jsonEncode(<String, Object?>{
    'toolName': 'Bash',
    'workingDirectory': '/fixture/项目',
    'input': <String, Object?>{'command': command},
    'context': <String, Object?>{
      'agentID': null,
      'decisionReason': null,
      'defaultToNo': false,
      'blockedPath': null,
      'mcpServer': null,
    },
  });
}

ApprovalSummary summaryFor(
  String jsonText, {
  int chunkCount = 1,
  String approvalId = 'approval_01',
  String sessionId = 'session_01',
  String runId = 'run_01',
  String workspaceId = 'ws_01',
  String toolName = 'Bash',
  bool defaultToNo = false,
}) {
  return ApprovalSummary(
    approvalId: approvalId,
    workspaceId: workspaceId,
    sessionId: sessionId,
    runId: runId,
    toolUseId: 'toolu_01',
    toolName: toolName,
    createdAt: 1762432800000,
    expiresAt: 1762432920000,
    defaultToNo: defaultToNo,
    content: ApprovalContentDescriptor(
      encoding: 'json-utf8',
      byteLength: utf8.encode(jsonText).length,
      sha256: sha256Base64Url(jsonText),
      chunkCount: chunkCount,
    ),
  );
}

/// 可编程 HTTP 传输；按 chunkIndex 返回预置块，其余 404。
final class FakeTransport implements ApprovalContentTransport {
  FakeTransport({
    Map<int, ApprovalTransportResponse>? chunks,
    this.onRequest,
  }) : chunks = chunks ?? <int, ApprovalTransportResponse>{};

  final Map<int, ApprovalTransportResponse> chunks;
  final List<Uri> requested = <Uri>[];
  Future<ApprovalTransportResponse> Function(int index)? onRequest;

  @override
  Future<ApprovalTransportResponse> get(
    Uri uri,
    Map<String, String> headers,
  ) async {
    requested.add(uri);
    final index = int.parse(uri.queryParameters['chunkIndex'] ?? '0');
    if (onRequest != null) return onRequest!(index);
    return chunks[index] ??
        const ApprovalTransportResponse(
          statusCode: 404,
          body: '{"error":{"code":"APPROVAL_NOT_FOUND"}}',
        );
  }
}

ApprovalTransportResponse chunkResponse({
  required String approvalId,
  required int chunkIndex,
  required int chunkCount,
  required int byteLength,
  required String sha256,
  required String text,
}) {
  return ApprovalTransportResponse(
    statusCode: 200,
    body: jsonEncode(<String, Object?>{
      'approvalId': approvalId,
      'chunkIndex': chunkIndex,
      'chunkCount': chunkCount,
      'encoding': 'json-utf8',
      'byteLength': byteLength,
      'sha256': sha256,
      'text': text,
    }),
  );
}

/// 可编程命令执行器；按顺序返回 JsonMap 或抛错。
final class FakeExecutor implements CommandExecutor {
  final List<CommandRequest<Object?>> requests = <CommandRequest<Object?>>[];
  final List<Object> outcomes = <Object>[];

  @override
  Future<T> execute<T>(
    CommandRequest<T> request, {
    Duration timeout = const Duration(seconds: 10),
  }) async {
    requests.add(request);
    if (outcomes.isEmpty) {
      throw const CommandFailure('NO_OUTCOME');
    }
    final outcome = outcomes.removeAt(0);
    if (outcome is Exception) throw outcome;
    return request.decode(outcome as JsonMap);
  }
}