import '../../connection/command_client.dart';
import '../../data/agent_socket.dart' show JsonMap;
import '../../protocol/envelope.dart';
import '../../protocol/s03_messages.dart';

/// permission.respond 的成功结果；不包含正文。
final class ApprovalCommandResult {
  const ApprovalCommandResult({
    required this.approvalId,
    required this.status,
    required this.resolvedAt,
  });

  static ApprovalCommandResult fromData(JsonMap data) {
    final approvalId = data['approvalId'];
    final status = ApprovalStatus.tryParse(data['status']);
    final resolvedAt = data['resolvedAt'];
    if (approvalId is! String || approvalId.isEmpty) {
      throw const CommandFailure('INVALID_RESPONSE');
    }
    if (status == null || status.isPending) {
      throw const CommandFailure('INVALID_RESPONSE');
    }
    if (resolvedAt is! int) {
      throw const CommandFailure('INVALID_RESPONSE');
    }
    return ApprovalCommandResult(
      approvalId: approvalId,
      status: status,
      resolvedAt: resolvedAt,
    );
  }

  final String approvalId;
  final ApprovalStatus status;
  final int resolvedAt;
}

/// 只负责发送 permission.respond：固定目标、固定 commandId、禁止双提交。
final class ApprovalCommandCoordinator {
  ApprovalCommandCoordinator({
    required this.client,
    required this.isOnline,
    required this.verifiedSha,
    this.timeout = const Duration(seconds: 10),
  });

  final CommandExecutor client;
  final bool Function() isOnline;
  final String? Function(String approvalId) verifiedSha;
  final Duration timeout;

  final Map<String, CommandRequest<ApprovalCommandResult>> _pending =
      <String, CommandRequest<ApprovalCommandResult>>{};
  final Set<String> _submitting = <String>{};
  final Set<String> _resolved = <String>{};
  int _sequence = 0;

  /// 已 resolved 的审批不再允许新决策。
  bool canSubmit(String approvalId) =>
      !_submitting.contains(approvalId) && !_resolved.contains(approvalId);

  /// 允许一次：必须在线且当前 summary 的内容 hash 已验证。
  Future<ApprovalCommandResult> allowOnce(ApprovalSummary summary) {
    _assertOnline();
    if (verifiedSha(summary.approvalId) != summary.content.sha256) {
      throw const CommandFailure('CONTENT_NOT_VERIFIED');
    }
    return _submit(summary, 'allow_once');
  }

  /// 拒绝：不要求已加载内容。
  Future<ApprovalCommandResult> deny(ApprovalSummary summary) {
    _assertOnline();
    return _submit(summary, 'deny');
  }

  /// 超时后用同一 request（同一 commandId）原样重试。
  Future<ApprovalCommandResult> retry(String approvalId) {
    final request = _pending[approvalId];
    if (request == null) {
      throw const CommandFailure('NO_PENDING_APPROVAL');
    }
    if (!canSubmit(approvalId)) {
      throw const CommandFailure('APPROVAL_SUBMITTING');
    }
    return _execute(approvalId, request);
  }

  /// 收到 permission.resolved 后清理并禁止再次提交。
  void resolved(String approvalId, PermissionResolution resolution) {
    _resolved.add(approvalId);
    _pending.remove(approvalId);
    _submitting.remove(approvalId);
    if (resolution.approvalId != approvalId) {
      throw const ProtocolConflictException('resolution approval mismatch');
    }
  }

  /// 新 agent 实例或凭证失效：全部旧请求不可重试。
  void invalidateAll() {
    _resolved.addAll(_pending.keys);
    _pending.clear();
    _submitting.clear();
  }

  Future<ApprovalCommandResult> _submit(
    ApprovalSummary summary,
    String decision,
  ) {
    final approvalId = summary.approvalId;
    if (!canSubmit(approvalId)) {
      return Future<ApprovalCommandResult>.error(
        const CommandFailure('APPROVAL_SUBMITTING'),
      );
    }
    final request = CommandRequest<ApprovalCommandResult>(
      commandId: 'cmd_approval_${approvalId}_${_sequence++}',
      traceId: 'trace_approval_$approvalId',
      type: 'permission.respond',
      sessionId: summary.sessionId,
      runId: summary.runId,
      workspaceId: summary.workspaceId,
      approvalId: approvalId,
      payload: <String, dynamic>{'decision': decision},
      decode: ApprovalCommandResult.fromData,
    );
    _pending[approvalId] = request;
    return _execute(approvalId, request);
  }

  Future<ApprovalCommandResult> _execute(
    String approvalId,
    CommandRequest<ApprovalCommandResult> request,
  ) async {
    if (_submitting.contains(approvalId)) {
      throw const CommandFailure('APPROVAL_SUBMITTING');
    }
    _submitting.add(approvalId);
    try {
      final result = await client.execute(request, timeout: timeout);
      _resolved.add(approvalId);
      _pending.remove(approvalId);
      return result;
    } on CommandFailure catch (error) {
      if (error.code == 'APPROVAL_DUPLICATE_AFTER_RESOLUTION' ||
          error.code == 'APPROVAL_ALREADY_RESOLVED' ||
          error.code == 'APPROVAL_EXPIRED') {
        _resolved.add(approvalId);
        _pending.remove(approvalId);
      }
      rethrow;
    } finally {
      _submitting.remove(approvalId);
    }
  }

  void _assertOnline() {
    if (!isOnline()) {
      throw const CommandFailure('NOT_CONNECTED');
    }
  }
}