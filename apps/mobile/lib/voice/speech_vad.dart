/// VAD 只产生辅助提示与自动 finish，不是安全边界。
enum VadAction { none, autoFinish }

/// 基于 RMS dBFS 的轻量静音检测。
final class SpeechVad {
  SpeechVad({
    this.speechThresholdDbfs = -40,
    this.silenceThresholdDbfs = -45,
    this.minSpeech = const Duration(milliseconds: 500),
    this.silenceToFinish = const Duration(milliseconds: 1500),
  }) : assert(speechThresholdDbfs > silenceThresholdDbfs);

  final double speechThresholdDbfs;
  final double silenceThresholdDbfs;
  final Duration minSpeech;
  final Duration silenceToFinish;

  Duration _speech = Duration.zero;
  Duration _silence = Duration.zero;
  Duration? _lastAt;
  bool _detected = false;
  bool _finished = false;

  /// 是否已累计足够的语音。
  bool get speechDetected => _detected;

  /// 输入一个采样点的音量与时间；达到静音阈值时返回 autoFinish 一次。
  VadAction addSample({required double rmsDbfs, required Duration at}) {
    final last = _lastAt;
    final delta = last == null ? Duration.zero : at - last;
    _lastAt = at;
    if (_finished) return VadAction.none;

    if (rmsDbfs >= speechThresholdDbfs) {
      if (!_detected) {
        _speech += delta;
        if (_speech >= minSpeech) _detected = true;
      }
      _silence = Duration.zero;
      return VadAction.none;
    }
    if (!_detected || rmsDbfs >= silenceThresholdDbfs) {
      return VadAction.none;
    }
    _silence += delta;
    if (_silence < silenceToFinish) return VadAction.none;
    _finished = true;
    return VadAction.autoFinish;
  }
}