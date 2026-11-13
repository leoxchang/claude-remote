import 'dart:convert';

import 'package:claude_remote/features/approvals/approval_command_coordinator.dart';
import 'package:claude_remote/features/approvals/approval_content_api.dart';
import 'package:claude_remote/features/approvals/approval_content_loader.dart';
import 'package:claude_remote/features/approvals/approval_controller.dart';
import 'package:claude_remote/protocol/s03_messages.dart';

import 'approval_test_support.dart';

String uiContent({
  required String toolName,
  required Map<String, Object?> input,
  String workingDirectory = '/fixture/项目',
  Map<String, Object?>? context,
}) {
  return jsonEncode(<String, Object?>{
    'toolName': toolName,
    'workingDirectory': workingDirectory,
    'input': input,
    'context': context ??
        <String, Object?>{
          'agentID': null,
          'decisionReason': 'tool requires approval',
          'defaultToNo': false,
          'blockedPath': null,
          'mcpServer': null,
        },
  });
}

final class UiHarness {
  UiHarness({
    required this.controller,
    required this.summary,
    required this.transport,
    required this.executor,
    required this.jsonText,
  });

  final ApprovalController controller;
  final ApprovalSummary summary;
  final FakeTransport transport;
  final FakeExecutor executor;
  final String jsonText;
}

UiHarness uiHarness({
  required String toolName,
  required Map<String, Object?> input,
  bool defaultToNo = false,
  String? jsonText,
  Map<String, Object?>? context,
  Future<ApprovalTransportResponse> Function(int index)? onRequest,
}) {
  final json = jsonText ??
      uiContent(toolName: toolName, input: input, context: context);
  final summary = summaryFor(
    json,
    toolName: toolName,
    defaultToNo: defaultToNo,
  );
  final transport = FakeTransport(
    chunks: <int, ApprovalTransportResponse>{
      0: chunkResponse(
        approvalId: summary.approvalId,
        chunkIndex: 0,
        chunkCount: 1,
        byteLength: summary.content.byteLength,
        sha256: summary.content.sha256,
        text: json,
      ),
    },
  );
  transport.onRequest = onRequest;
  final executor = FakeExecutor()
    ..outcomes.add(<String, Object?>{
      'approvalId': summary.approvalId,
      'status': 'approved_once',
      'resolvedAt': 1762432860000,
    });
  late final ApprovalController controller;
  controller = ApprovalController(
    loader: ApprovalContentLoader(
      ApprovalContentApi(
        credentials: credentialStore(),
        transport: transport,
      ),
    ),
    coordinator: ApprovalCommandCoordinator(
      client: executor,
      isOnline: () => true,
      verifiedSha: (approvalId) =>
          controller.approvalContentCache[approvalId]?.sha256,
    ),
  );
  controller.registerPending(summary);
  return UiHarness(
    controller: controller,
    summary: summary,
    transport: transport,
    executor: executor,
    jsonText: json,
  );
}

PermissionResolution resolutionFor(
  ApprovalSummary summary, {
  ApprovalStatus status = ApprovalStatus.denied,
  ResolutionReason reason = ResolutionReason.userDeny,
}) {
  return PermissionResolution(
    approvalId: summary.approvalId,
    sessionId: summary.sessionId,
    runId: summary.runId,
    status: status,
    resolvedAt: 1762432860000,
    reason: reason,
  );
}