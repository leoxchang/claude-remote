/// 与协议 `run.completed.status` 对齐的 run 状态。
enum RunStatus {
  starting,
  running,
  waitingApproval,
  cancelling,
  succeeded,
  failed,
  cancelled,
  interrupted;

  /// wire 名称；`waitingApproval` 对应 `waiting_approval`。
  String get wireName => switch (this) {
        RunStatus.waitingApproval => 'waiting_approval',
        _ => name,
      };

  /// 把 wire 字符串转成状态；未知值返回 null，由调用方保留旧状态。
  static RunStatus? tryParse(String? value) {
    for (final status in RunStatus.values) {
      if (status.wireName == value) return status;
    }
    return null;
  }
}