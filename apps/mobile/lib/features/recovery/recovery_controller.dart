import 'package:flutter/foundation.dart' show ChangeNotifier;
import 'package:flutter/widgets.dart' show AppLifecycleState;

/// 恢复列表中的一条 recovery_required run；不含正文。
final class RecoveryRunSummary {
  const RecoveryRunSummary({
    required this.runId,
    required this.sessionId,
    required this.recoveryGeneration,
    this.promptExpiresAt,
  });

  final String runId;
  final String sessionId;
  final int recoveryGeneration;
  final int? promptExpiresAt;
}

typedef RecoveryPromptLoader = Future<String> Function(String runId);
typedef RecoveryRequeue = Future<void> Function(
  String runId,
  String sessionId,
  int recoveryGeneration,
);
typedef RecoveryDiscard = Future<void> Function(String runId);
typedef ExecutionIntentGate = Future<bool> Function(String sessionId);

/// 显式恢复交互：查看原 prompt、requeue、discard、后台遮罩。
final class RecoveryController extends ChangeNotifier {
  RecoveryController({
    required RecoveryPromptLoader loadPromptText,
    required RecoveryRequeue requeueRun,
    required RecoveryDiscard discardRun,
    required ExecutionIntentGate canStartIntent,
    bool Function()? isOnline,
  }) : _loadPromptText = loadPromptText,
       _requeueRun = requeueRun,
       _discardRun = discardRun,
       _canStartIntent = canStartIntent,
       _isOnline = isOnline ?? (() => true);

  final RecoveryPromptLoader _loadPromptText;
  final RecoveryRequeue _requeueRun;
  final RecoveryDiscard _discardRun;
  final ExecutionIntentGate _canStartIntent;
  final bool Function() _isOnline;
  final Map<String, RecoveryRunSummary> _runs = {};
  final Map<String, String> _prompts = {};
  final Set<String> _loading = {};
  int _generation = 0;
  bool _masked = false;
  String? _lastError;

  bool get masked => _masked;

  String? get lastError => _lastError;

  List<RecoveryRunSummary> get runs =>
      _runs.values.toList(growable: false);

  String? promptOf(String runId) => _prompts[runId];

  bool isLoading(String runId) => _loading.contains(runId);

  /// 快照/同步到达后替换恢复列表；正文只保留仍在列表中的条目。
  void registerRecoveryRuns(List<RecoveryRunSummary> runs) {
    if (_masked) return;
    final ids = runs.map((run) => run.runId).toSet();
    _prompts.removeWhere((runId, _) => !ids.contains(runId));
    _runs
      ..removeWhere((runId, _) => !ids.contains(runId))
      ..addEntries(runs.map((run) => MapEntry(run.runId, run)));
    notifyListeners();
  }

  /// 只有看过原 prompt 且在线、未遮罩时才允许 requeue。
  bool canRequeue(RecoveryRunSummary run) {
    return !_masked && _isOnline() && _prompts.containsKey(run.runId);
  }

  /// 加载原 prompt；迟到结果在遮罩或 run 消失后丢弃。
  Future<void> loadPrompt(String runId) async {
    if (_masked || _loading.contains(runId)) return;
    final generation = _generation;
    _loading.add(runId);
    notifyListeners();
    try {
      final text = await _loadPromptText(runId);
      if (generation != _generation || _masked || !_runs.containsKey(runId)) {
        return;
      }
      _prompts[runId] = text;
    } finally {
      _loading.remove(runId);
      notifyListeners();
    }
  }

  /// 显式 requeue；捕获 runId/sessionId/generation，切换页面不改目标。
  Future<void> requeue(String runId) async {
    final run = _runs[runId];
    if (run == null) return;
    if (!canRequeue(run)) return;
    if (!await _canStartIntent(run.sessionId)) return;
    final generation = _generation;
    try {
      await _requeueRun(run.runId, run.sessionId, run.recoveryGeneration);
    } on Object {
      _lastError = '恢复失败，请确认原 prompt 后重试';
      notifyListeners();
      return;
    }
    if (generation != _generation) return;
    _runs.remove(runId);
    _prompts.remove(runId);
    _lastError = null;
    notifyListeners();
  }

  /// 丢弃本地恢复记录；不撤销 Mac 已接受的执行。
  Future<void> discard(String runId) async {
    try {
      await _discardRun(runId);
      _runs.remove(runId);
      _prompts.remove(runId);
      _lastError = null;
    } on Object {
      _lastError = '放弃本地重试失败，请重试';
    }
    notifyListeners();
  }

  /// 后台/锁屏清正文并遮罩；回前台由同步重新拉取。
  void onLifecycle(AppLifecycleState state) {
    final background =
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached;
    if (!background) return;
    _generation += 1;
    _masked = true;
    _prompts.clear();
    _loading.clear();
    notifyListeners();
  }

  /// 回前台解除遮罩；列表由新快照/同步提供。
  void onResume(List<RecoveryRunSummary> runs) {
    _generation += 1;
    _masked = false;
    registerRecoveryRuns(runs);
  }

  void clearAll() {
    _generation += 1;
    _runs.clear();
    _prompts.clear();
    _loading.clear();
    notifyListeners();
  }
}