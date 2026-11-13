import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState;

import '../../connection/command_client.dart';
import '../../domain/approval.dart';
import '../../protocol/s03_messages.dart';
import 'approval_command_coordinator.dart';
import 'approval_content_loader.dart';

/// 单个审批的本地动作状态。
enum ApprovalActionState {
  loadingContent,
  ready,
  submitting,
  resolved,
  error,
  unknown,
}

bool _alwaysOnline() => true;

/// 只有内存内容缓存与动作状态；不写 Keychain、文件或日志。
final class ApprovalController extends ChangeNotifier {
  ApprovalController({
    required this.loader,
    required this.coordinator,
    this.isOnline = _alwaysOnline,
  });

  final ApprovalContentLoader loader;
  final ApprovalCommandCoordinator coordinator;
  final bool Function() isOnline;

  final Map<String, VerifiedApprovalContent> _content = {};
  final Map<String, ApprovalActionState> _states = {};
  final Map<String, ApprovalSummary> _pending = {};
  int _generation = 0;
  bool _masked = false;

  /// 只读正文缓存；调用方不得持久化。
  Map<String, VerifiedApprovalContent> get approvalContentCache =>
      Map<String, VerifiedApprovalContent>.unmodifiable(_content);

  /// 指定会话当前 pending 的摘要，按到达顺序。
  List<ApprovalSummary> pendingForSession(String sessionId) => _pending.values
      .where((summary) => summary.sessionId == sessionId)
      .toList(growable: false);

  /// 后台遮罩；遮罩期间禁止允许。
  bool get masked => _masked;

  ApprovalActionState? stateOf(String approvalId) => _states[approvalId];

  /// 记录一个 pending 摘要并自动加载内容。
  void registerPending(ApprovalSummary summary) {
    final state = _states[summary.approvalId];
    if (state == ApprovalActionState.resolved ||
        state == ApprovalActionState.unknown) {
      return;
    }
    _pending[summary.approvalId] = summary;
    unawaited(loadContent(summary));
  }

  /// 允许一次：必须在线、未遮罩、内容已校验且未 resolved。
  bool canAllow(ApprovalSummary summary) {
    if (_masked || !isOnline()) return false;
    final content = _content[summary.approvalId];
    if (content == null || content.sha256 != summary.content.sha256) {
      return false;
    }
    return coordinator.canSubmit(summary.approvalId);
  }

  /// 拒绝只需要在线且未 resolved。
  bool canDeny(ApprovalSummary summary) =>
      !_masked && isOnline() && coordinator.canSubmit(summary.approvalId);

  /// 加载并校验完整内容；迟到结果不得重新写入缓存。
  Future<void> loadContent(ApprovalSummary summary) async {
    final approvalId = summary.approvalId;
    final generation = _generation;
    _states[approvalId] = ApprovalActionState.loadingContent;
    notifyListeners();
    try {
      final content = await loader.load(summary);
      if (generation != _generation ||
          _states[approvalId] == ApprovalActionState.resolved ||
          _states[approvalId] == ApprovalActionState.unknown) {
        return;
      }
      _content[approvalId] = content;
      _states[approvalId] = ApprovalActionState.ready;
      notifyListeners();
    } on Object {
      if (generation != _generation) return;
      _content.remove(approvalId);
      if (_states[approvalId] != ApprovalActionState.resolved) {
        _states[approvalId] = ApprovalActionState.error;
      }
      notifyListeners();
    }
  }

  Future<ApprovalCommandResult> allowOnce(ApprovalSummary summary) async {
    if (!canAllow(summary)) {
      throw const CommandFailure('APPROVAL_NOT_READY');
    }
    _states[summary.approvalId] = ApprovalActionState.submitting;
    notifyListeners();
    try {
      final result = await coordinator.allowOnce(summary);
      _pending.remove(summary.approvalId);
      _markResolved(summary.approvalId);
      notifyListeners();
      return result;
    } on Object {
      if (_states[summary.approvalId] != ApprovalActionState.resolved) {
        _states[summary.approvalId] = ApprovalActionState.error;
      }
      notifyListeners();
      rethrow;
    }
  }

  Future<ApprovalCommandResult> deny(ApprovalSummary summary) async {
    if (!canDeny(summary)) {
      throw const CommandFailure('APPROVAL_NOT_READY');
    }
    _states[summary.approvalId] = ApprovalActionState.submitting;
    notifyListeners();
    try {
      final result = await coordinator.deny(summary);
      _pending.remove(summary.approvalId);
      _markResolved(summary.approvalId);
      notifyListeners();
      return result;
    } on Object {
      if (_states[summary.approvalId] != ApprovalActionState.resolved) {
        _states[summary.approvalId] = ApprovalActionState.error;
      }
      notifyListeners();
      rethrow;
    }
  }

  /// permission.resolved 到达：清除正文并保留安全终态。
  void onResolved(PermissionResolution resolution) {
    coordinator.resolved(resolution.approvalId, resolution);
    _pending.remove(resolution.approvalId);
    _markResolved(resolution.approvalId);
    notifyListeners();
  }

  /// 退后台立即遮罩并清空正文；迟到 Future 完成后不会再缓存。
  void onLifecycle(AppLifecycleState state) {
    final background =
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached;
    if (!background) return;
    _masked = true;
    clearAll();
  }

  /// 回前台：解除遮罩，用快照 pending 重新加载。
  Future<void> onResume(List<ApprovalSummary> pending) async {
    _masked = false;
    final sessionIds = pending.map((summary) => summary.sessionId).toSet();
    _pending.removeWhere(
      (approvalId, summary) => sessionIds.contains(summary.sessionId),
    );
    for (final summary in pending) {
      _pending[summary.approvalId] = summary;
    }
    notifyListeners();
    await Future.wait(
      pending.map((summary) => loadContent(summary)),
    );
  }

  /// Agent 实例变化：清除全部正文、取消自动重试，旧审批标为结果未知。
  void onAgentInstanceChanged() {
    _generation += 1;
    _content.clear();
    _pending.clear();
    for (final approvalId in _states.keys.toList()) {
      if (_states[approvalId] != ApprovalActionState.resolved) {
        _states[approvalId] = ApprovalActionState.unknown;
      }
    }
    coordinator.invalidateAll();
    notifyListeners();
  }

  /// 清除单个审批正文；之后迟到的加载结果被丢弃。
  void clear(String approvalId) {
    _generation += 1;
    _content.remove(approvalId);
    notifyListeners();
  }

  /// 清除全部正文（退后台、revoke、重启）。
  void clearAll() {
    _generation += 1;
    _content.clear();
    notifyListeners();
  }

  void _markResolved(String approvalId) {
    _states[approvalId] = ApprovalActionState.resolved;
    _content.remove(approvalId);
  }
}