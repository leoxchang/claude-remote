import 'dart:async';
import 'dart:typed_data';

import 'audio_level.dart';
import 'pcm_packetizer.dart';
import 'speech_vad.dart';
import 'voice_asr_client.dart';
import 'voice_audio_capture.dart';
import 'voice_draft_repository.dart';
import 'voice_ui_state.dart';

/// 单次录音上限。
const Duration maxVoiceRecording = Duration(seconds: 60);

/// 取消原因；只有 interruption 会显示安全错误状态。
enum VoiceCancelReason {
  user,
  background,
  interruption,
  socketClosed,
  agentRestarted,
}

/// 控制器与聊天的唯一接口；由 Composer 适配。
abstract interface class VoiceDraftAccess {
  String get selectedSessionId;
  String draftOf(String sessionId);
  void setDraft(String sessionId, String text);
  void showVoiceError(String code, String safeMessage);
}

/// 按住说话状态机；partial 只在内存与 UI 状态中。
final class VoiceInputController {
  VoiceInputController({
    required VoiceAsrClientFactory clientFactory,
    required VoiceAudioCapture capture,
    required VoiceDraftStore drafts,
    required VoiceDraftAccess access,
    SpeechVad? vad,
    PcmPacketizer? packetizer,
    this.onPendingDraftChanged,
  }) : _clientFactory = clientFactory,
       _capture = capture,
       _drafts = drafts,
       _access = access,
       _vad = vad ?? SpeechVad(),
       _packetizer = packetizer ?? PcmPacketizer();

  /// final 写入或取消后通知 Composer 绑定/解绑 voice draft。
  final void Function(String? voiceDraftId, String? sessionId)?
  onPendingDraftChanged;

  final VoiceAsrClientFactory _clientFactory;
  final VoiceAudioCapture _capture;
  final VoiceDraftStore _drafts;
  final VoiceDraftAccess _access;
  final SpeechVad _vad;
  final PcmPacketizer _packetizer;

  final StreamController<VoiceUiState> _states =
      StreamController<VoiceUiState>.broadcast();

  VoiceUiState _state = const VoiceIdle();
  VoiceAsrConnection? _connection;
  StreamSubscription<AsrServerEvent>? _events;
  StreamSubscription<Uint8List>? _audio;
  Timer? _ticker;
  int _generation = 0;
  int _counter = 0;
  bool _fingerDown = false;
  bool _speechDetected = false;
  bool _finalReceived = false;
  int _lastSequence = 0;
  Duration _elapsed = Duration.zero;
  String? _asrStreamId;
  String? _voiceDraftId;
  String? _originSessionId;
  String? _originalDraft;
  String? _pendingVoiceDraftId;

  VoiceUiState get state => _state;
  Stream<VoiceUiState> get states => _states.stream;

  /// origin session 在录音/识别中不可编辑、不可归档。
  bool get holdsOriginSession =>
      _state is VoiceRecording || _state is VoiceFinalizing;

  String? get originSessionId => _originSessionId;
  String? get asrStreamId => _asrStreamId;

  /// 尚未被普通 Composer 发送的 voice draft。
  String? get pendingVoiceDraftId => _pendingVoiceDraftId;
  String? get pendingVoiceSessionId =>
      _pendingVoiceDraftId == null ? null : _originSessionId;

  /// 用户按下麦克风；权限与连接期间松手会直接取消。
  Future<void> press() async {
    if (_state is! VoiceIdle) return;
    _fingerDown = true;
    _generation += 1;
    final generation = _generation;
    _counter += 1;
    final stamp = DateTime.now().microsecondsSinceEpoch;
    _asrStreamId = 'asr_${stamp}_$_counter';
    _voiceDraftId = 'vd_${stamp}_$_counter';
    _originSessionId = _access.selectedSessionId;
    _originalDraft = _access.draftOf(_originSessionId!);
    _lastSequence = 0;
    _elapsed = Duration.zero;
    _speechDetected = false;
    _finalReceived = false;
    _setState(const VoiceConnecting());

    final granted = await _capture.hasPermission();
    if (!_active(generation)) return;
    if (!granted) {
      _fail('ASR_PERMISSION_DENIED', false, generation);
      return;
    }
    VoiceAsrConnection connection;
    try {
      connection = await _clientFactory.connect();
    } on Object {
      _fail('ASR_CONNECTION_FAILED', true, generation);
      return;
    }
    if (!_active(generation)) {
      await connection.close();
      return;
    }
    _connection = connection;
    _events = connection.events.listen((event) => _onEvent(event, generation));
    try {
      await connection.sendStart(asrStreamId: _asrStreamId!);
    } on Object {
      _fail('ASR_CONNECTION_FAILED', true, generation);
    }
  }

  /// 松手：connecting 阶段直接取消，recording 阶段进入 finalizing。
  Future<void> release() async {
    _fingerDown = false;
    final state = _state;
    if (state is VoiceConnecting) {
      await cancel(VoiceCancelReason.user);
      return;
    }
    if (state is! VoiceRecording) return;
    await _stopAndFinish();
  }

  /// 取消当前流；迟到事件全部丢弃。
  Future<void> cancel(VoiceCancelReason reason) async {
    _fingerDown = false;
    if (_state is VoiceIdle || _state is VoiceErrorState) {
      await _cleanup();
      _setState(const VoiceIdle());
      return;
    }
    _generation += 1;
    final connection = _connection;
    connection?.sendCancel();
    await _cleanup();
    if (reason == VoiceCancelReason.interruption) {
      _setError('ASR_INTERRUPTED', false);
    } else if (reason == VoiceCancelReason.socketClosed) {
      _setError('ASR_CONNECTION_FAILED', true);
    } else {
      _setState(const VoiceIdle());
    }
  }

  /// 用户编辑合并后的草稿：同步 voice_drafts 与 drafts。
  Future<void> updateCombinedDraft(String text) async {
    final id = _pendingVoiceDraftId;
    final origin = _originSessionId;
    if (id == null || origin == null) return;
    await _drafts.updateCombinedDraft(id, text);
    _access.setDraft(origin, text);
  }

  /// 取消本次语音草稿：恢复原草稿并删除 voice_drafts。
  Future<void> discardVoiceDraft() async {
    final id = _pendingVoiceDraftId;
    final origin = _originSessionId;
    if (id == null || origin == null) return;
    await _drafts.restoreOriginal(id);
    _pendingVoiceDraftId = null;
    _access.setDraft(origin, _originalDraft ?? '');
    onPendingDraftChanged?.call(null, null);
  }

  void dismissError() {
    if (_state is VoiceErrorState) _setState(const VoiceIdle());
  }

  void dispose() {
    _generation += 1;
    _fingerDown = false;
    unawaited(_cleanup());
    unawaited(_capture.dispose());
    unawaited(_states.close());
  }

  void _onEvent(AsrServerEvent event, int generation) {
    if (generation != _generation) return;
    if (event is AsrStarted) {
      if (_state is VoiceConnecting && _fingerDown) {
        unawaited(_startCapture(generation));
      }
      return;
    }
    if (event is AsrPartial) {
      if (_state is! VoiceRecording || event.asrStreamId != _asrStreamId) {
        return;
      }
      if (event.sequence <= _lastSequence) return;
      _lastSequence = event.sequence;
      _publishRecording(partialText: event.text);
      return;
    }
    if (event is AsrFinal) {
      if (_state is! VoiceFinalizing || event.asrStreamId != _asrStreamId) {
        return;
      }
      _finalReceived = true;
      unawaited(_commitFinal(event.text, generation));
      return;
    }
    if (event is AsrServerError) {
      if (_state is VoiceIdle || _state is VoiceErrorState) return;
      unawaited(_failEvent(event, generation));
      return;
    }
    if (event is AsrCancelled) {
      if (_finalReceived) return;
      unawaited(cancel(VoiceCancelReason.agentRestarted));
      return;
    }
    if (event is AsrClosed) {
      // final 之后的 closed 是正常完成，不能覆盖草稿提交。
      if (_finalReceived) return;
      if (_state is VoiceIdle || _state is VoiceErrorState) return;
      unawaited(cancel(VoiceCancelReason.socketClosed));
    }
  }

  Future<void> _startCapture(int generation) async {
    final Stream<Uint8List> stream;
    try {
      stream = await _capture.start();
    } on Object {
      _fail('ASR_MIC_UNAVAILABLE', false, generation);
      return;
    }
    if (!_active(generation) || _state is! VoiceConnecting) {
      await _capture.stop();
      return;
    }
    _elapsed = Duration.zero;
    _speechDetected = false;
    _audio = stream.listen(
      (chunk) => _onAudio(chunk, generation),
      onError: (Object _) => _fail('ASR_MIC_UNAVAILABLE', false, generation),
    );
    _ticker = Timer.periodic(const Duration(milliseconds: 100), (_) {
      if (_state is! VoiceRecording) return;
      _elapsed += const Duration(milliseconds: 100);
      _publishRecording();
      if (_elapsed >= maxVoiceRecording) unawaited(release());
    });
    _setState(
      VoiceRecording(
        asrStreamId: _asrStreamId!,
        elapsed: Duration.zero,
        partialText: '',
        speechDetected: false,
      ),
    );
  }

  void _onAudio(Uint8List chunk, int generation) {
    if (!_active(generation) || _state is! VoiceRecording) return;
    final level = rmsDbfsPcm16(chunk);
    final action = _vad.addSample(rmsDbfs: level, at: _elapsed);
    _speechDetected = _vad.speechDetected;
    for (final frame in _packetizer.add(chunk)) {
      _connection?.sendAudio(frame);
    }
    _publishRecording();
    if (action == VadAction.autoFinish) unawaited(release());
  }

  Future<void> _stopAndFinish() async {
    final connection = _connection;
    if (connection == null) {
      await _cleanup();
      _setState(const VoiceIdle());
      return;
    }
    _ticker?.cancel();
    _ticker = null;
    unawaited(_audio?.cancel());
    _audio = null;
    await _capture.stop();
    _setState(VoiceFinalizing(asrStreamId: _asrStreamId!));
    connection.sendFinish();
  }

  Future<void> _commitFinal(String text, int generation) async {
    if (generation != _generation) return;
    final origin = _originSessionId;
    final original = _originalDraft;
    final voiceDraftId = _voiceDraftId;
    final streamId = _asrStreamId;
    if (origin == null ||
        original == null ||
        voiceDraftId == null ||
        streamId == null) {
      return;
    }
    try {
      final draft = await _drafts.commitFinal(
        voiceDraftId: voiceDraftId,
        asrStreamId: streamId,
        originSessionId: origin,
        originalDraft: original,
        finalText: text,
      );
      _pendingVoiceDraftId = voiceDraftId;
      _access.setDraft(origin, draft.combinedDraft);
      onPendingDraftChanged?.call(voiceDraftId, origin);
      await _cleanup();
      _setState(const VoiceIdle());
    } on VoiceDraftConflict {
      await _cleanup();
      _access.showVoiceError('ASR_DRAFT_CONFLICT', 'ASR_DRAFT_CONFLICT');
      _setError('ASR_DRAFT_CONFLICT', false);
    } on Object {
      await _cleanup();
      _setError('STORAGE_UNAVAILABLE', false);
    }
  }

  Future<void> _failEvent(AsrServerError event, int generation) async {
    if (generation != _generation) return;
    await _cleanup();
    _access.showVoiceError(event.code, event.safeMessage);
    _setState(
      VoiceErrorState(
        code: event.code,
        safeMessage: event.safeMessage,
        retryable: event.retryable,
      ),
    );
  }

  Future<void> _fail(String code, bool retryable, int generation) async {
    if (generation != _generation) return;
    await _cleanup();
    _access.showVoiceError(code, code);
    _setState(
      VoiceErrorState(code: code, safeMessage: code, retryable: retryable),
    );
  }

  Future<void> _cleanup() async {
    _ticker?.cancel();
    _ticker = null;
    unawaited(_audio?.cancel());
    _audio = null;
    unawaited(_events?.cancel());
    _events = null;
    final connection = _connection;
    _connection = null;
    await connection?.close();
    await _capture.stop();
  }

  void _publishRecording({String? partialText}) {
    final state = _state;
    if (state is! VoiceRecording) return;
    _setState(
      VoiceRecording(
        asrStreamId: state.asrStreamId,
        elapsed: _elapsed,
        partialText: partialText ?? state.partialText,
        speechDetected: _speechDetected,
      ),
    );
  }

  bool _active(int generation) =>
      generation == _generation && _fingerDown && _state is! VoiceErrorState;

  void _setState(VoiceUiState state) {
    _state = state;
    if (!_states.isClosed) _states.add(state);
  }

  void _setError(String code, bool retryable) {
    _setState(
      VoiceErrorState(
        code: code,
        safeMessage: code,
        retryable: retryable,
      ),
    );
  }
}