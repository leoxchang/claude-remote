/// 与协议 `run.completed.status` 对齐的 run 状态。
enum RunStatus {
  starting,
  running,
  cancelling,
  succeeded,
  failed,
  cancelled,
  interrupted;

  /// 把 wire 字符串转成状态；未知值返回 null，由调用方保留旧状态。
  static RunStatus? tryParse(String? value) {
    for (final status in RunStatus.values) {
      if (status.name == value) return status;
    }
    return null;
  }
}