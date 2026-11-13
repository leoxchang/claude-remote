/// 语音 UI 的不可变状态。
sealed class VoiceUiState {
  const VoiceUiState();
}

final class VoiceIdle extends VoiceUiState {
  const VoiceIdle();
}

final class VoiceConnecting extends VoiceUiState {
  const VoiceConnecting();
}

final class VoiceRecording extends VoiceUiState {
  const VoiceRecording({
    required this.asrStreamId,
    required this.elapsed,
    required this.partialText,
    required this.speechDetected,
  });

  final String asrStreamId;
  final Duration elapsed;
  final String partialText;
  final bool speechDetected;
}

final class VoiceFinalizing extends VoiceUiState {
  const VoiceFinalizing({required this.asrStreamId});
  final String asrStreamId;
}

final class VoiceErrorState extends VoiceUiState {
  const VoiceErrorState({
    required this.code,
    required this.safeMessage,
    required this.retryable,
  });

  final String code;
  final String safeMessage;
  final bool retryable;
}