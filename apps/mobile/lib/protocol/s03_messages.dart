import 'messages.dart';

/// 审批终态；与协议 `permission.resolved.payload.status` 对齐。
enum ApprovalStatus {
  pending,
  approvedOnce,
  denied,
  expired,
  invalidated;

  /// wire 名称。
  String get wireName => switch (this) {
        ApprovalStatus.pending => 'pending',
        ApprovalStatus.approvedOnce => 'approved_once',
        ApprovalStatus.denied => 'denied',
        ApprovalStatus.expired => 'expired',
        ApprovalStatus.invalidated => 'invalidated',
      };

  /// 解析 wire 值；未知返回 null。
  static ApprovalStatus? tryParse(Object? value) {
    if (value is! String) return null;
    for (final status in ApprovalStatus.values) {
      if (status.wireName == value) return status;
    }
    return null;
  }

  /// 是否仍可决策。
  bool get isPending => this == ApprovalStatus.pending;
}

/// 终态原因；与协议 `resolutionReason` 对齐。
enum ResolutionReason {
  userAllowOnce,
  userDeny,
  timeout,
  runCancelled,
  sdkAborted,
  policyDisabled,
  deviceRevoked,
  agentShutdown;

  /// wire 名称。
  String get wireName => switch (this) {
        ResolutionReason.userAllowOnce => 'user_allow_once',
        ResolutionReason.userDeny => 'user_deny',
        ResolutionReason.timeout => 'timeout',
        ResolutionReason.runCancelled => 'run_cancelled',
        ResolutionReason.sdkAborted => 'sdk_aborted',
        ResolutionReason.policyDisabled => 'policy_disabled',
        ResolutionReason.deviceRevoked => 'device_revoked',
        ResolutionReason.agentShutdown => 'agent_shutdown',
      };

  /// 解析 wire 值；未知返回 null。
  static ResolutionReason? tryParse(Object? value) {
    if (value is! String) return null;
    for (final reason in ResolutionReason.values) {
      if (reason.wireName == value) return reason;
    }
    return null;
  }
}

/// 完整内容的安全描述；不含正文。
final class ApprovalContentDescriptor {
  const ApprovalContentDescriptor({
    required this.encoding,
    required this.byteLength,
    required this.sha256,
    required this.chunkCount,
  });

  /// 从 wire 解析；非法时返回 null，调用方不得启用允许。
  static ApprovalContentDescriptor? fromWire(Object? wire) {
    if (wire is! Map) return null;
    final encoding = wire['encoding'];
    final byteLength = wire['byteLength'];
    final sha256 = wire['sha256'];
    final chunkCount = wire['chunkCount'];
    if (encoding != 'json-utf8') return null;
    if (byteLength is! int || byteLength < 0) return null;
    if (sha256 is! String || sha256.isEmpty) return null;
    if (chunkCount is! int || chunkCount < 1) return null;
    return ApprovalContentDescriptor(
      encoding: 'json-utf8',
      byteLength: byteLength,
      sha256: sha256,
      chunkCount: chunkCount,
    );
  }

  final String encoding;
  final int byteLength;
  final String sha256;
  final int chunkCount;
}

/// pending 审批的安全摘要；不包含命令、路径或输入正文。
final class ApprovalSummary {
  const ApprovalSummary({
    required this.approvalId,
    required this.workspaceId,
    required this.sessionId,
    required this.runId,
    required this.toolUseId,
    required this.toolName,
    required this.createdAt,
    required this.expiresAt,
    required this.defaultToNo,
    required this.content,
    this.agentId,
  });

  /// 从 `permission.requested` 事件构造。
  static ApprovalSummary? fromEvent(TimelineEvent event) {
    final approvalId = event.approvalId;
    final runId = event.runId;
    final payload = event.payload;
    final toolUseId = payload['toolUseID'];
    final toolName = payload['toolName'];
    final createdAt = payload['createdAt'];
    final expiresAt = payload['expiresAt'];
    final content = ApprovalContentDescriptor.fromWire(payload['content']);
    if (approvalId == null || runId == null) return null;
    if (toolUseId is! String || toolUseId.isEmpty) return null;
    if (toolName is! String || toolName.isEmpty) return null;
    if (createdAt is! int || expiresAt is! int) return null;
    if (content == null) return null;
    return ApprovalSummary(
      approvalId: approvalId,
      workspaceId: _stringOrEmpty(payload['workspaceId']),
      sessionId: event.sessionId,
      runId: runId,
      toolUseId: toolUseId,
      toolName: toolName,
      createdAt: createdAt,
      expiresAt: expiresAt,
      defaultToNo: payload['defaultToNo'] == true,
      content: content,
      agentId: _stringOrNull(payload['agentID']),
    );
  }

  /// 从快照的 `pendingApprovals` 条目构造；缺省 ID 由快照上下文补齐。
  static ApprovalSummary? fromSnapshotEntry(
    Object? wire, {
    required String sessionId,
    required String workspaceId,
    required String runId,
  }) {
    if (wire is! Map) return null;
    final approvalId = wire['approvalId'];
    final toolUseId = wire['toolUseID'];
    final toolName = wire['toolName'];
    final createdAt = wire['createdAt'];
    final expiresAt = wire['expiresAt'];
    final content = ApprovalContentDescriptor.fromWire(wire['content']);
    if (approvalId is! String || approvalId.isEmpty) return null;
    if (toolUseId is! String || toolUseId.isEmpty) return null;
    if (toolName is! String || toolName.isEmpty) return null;
    if (createdAt is! int || expiresAt is! int) return null;
    if (content == null) return null;
    return ApprovalSummary(
      approvalId: approvalId,
      workspaceId: _stringOrEmpty(wire['workspaceId']).isEmpty
          ? workspaceId
          : _stringOrEmpty(wire['workspaceId']),
      sessionId: sessionId,
      runId: _stringOrEmpty(wire['runId']).isEmpty
          ? runId
          : _stringOrEmpty(wire['runId']),
      toolUseId: toolUseId,
      toolName: toolName,
      createdAt: createdAt,
      expiresAt: expiresAt,
      defaultToNo: wire['defaultToNo'] == true,
      content: content,
      agentId: _stringOrNull(wire['agentID']),
    );
  }

  final String approvalId;
  final String workspaceId;
  final String sessionId;
  final String runId;
  final String toolUseId;
  final String toolName;
  final int createdAt;
  final int expiresAt;
  final bool defaultToNo;
  final ApprovalContentDescriptor content;
  final String? agentId;
}

/// `permission.resolved` 的不可变结果。
final class PermissionResolution {
  const PermissionResolution({
    required this.approvalId,
    required this.sessionId,
    required this.runId,
    required this.status,
    required this.resolvedAt,
    required this.reason,
    this.responseCommandId,
  });

  /// 从事件构造；非法必填字段返回 null。
  static PermissionResolution? fromEvent(TimelineEvent event) {
    final approvalId = event.approvalId;
    final runId = event.runId;
    final status = ApprovalStatus.tryParse(event.payload['status']);
    final resolvedAt = event.payload['resolvedAt'];
    final reason = ResolutionReason.tryParse(event.payload['resolutionReason']);
    if (approvalId == null || runId == null) return null;
    if (status == null || status == ApprovalStatus.pending) return null;
    if (resolvedAt is! int) return null;
    if (reason == null) return null;
    return PermissionResolution(
      approvalId: approvalId,
      sessionId: event.sessionId,
      runId: runId,
      status: status,
      resolvedAt: resolvedAt,
      reason: reason,
      responseCommandId: _stringOrNull(event.payload['responseCommandId']),
    );
  }

  final String approvalId;
  final String sessionId;
  final String runId;
  final ApprovalStatus status;
  final int resolvedAt;
  final ResolutionReason reason;
  final String? responseCommandId;
}

/// 内容 endpoint 的单块响应。
final class ApprovalContentChunk {
  const ApprovalContentChunk({
    required this.approvalId,
    required this.chunkIndex,
    required this.chunkCount,
    required this.encoding,
    required this.byteLength,
    required this.sha256,
    required this.text,
  });

  final String approvalId;
  final int chunkIndex;
  final int chunkCount;
  final String encoding;
  final int byteLength;
  final String sha256;
  final String text;
}

String? _stringOrNull(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

String _stringOrEmpty(Object? value) => value is String ? value : '';