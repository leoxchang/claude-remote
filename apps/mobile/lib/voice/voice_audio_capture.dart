import 'dart:typed_data';

import 'package:record/record.dart';

/// 录音采集抽象；测试注入 fake，生产使用 `record 7.1.2`。
abstract interface class VoiceAudioCapture {
  Future<bool> hasPermission();
  Future<Stream<Uint8List>> start();
  Future<void> stop();
  Future<void> dispose();
}

/// 对 `record` 的最小适配层。
abstract interface class VoiceRecorderAdapter {
  Future<bool> hasPermission();
  Future<Stream<Uint8List>> startStream(RecordConfig config);
  Future<void> stop();
  Future<void> dispose();
}

/// 生产适配器；只使用 startStream，不创建录音文件。
final class RecordRecorderAdapter implements VoiceRecorderAdapter {
  RecordRecorderAdapter({AudioRecorder? recorder})
    : _recorder = recorder ?? AudioRecorder();

  final AudioRecorder _recorder;

  @override
  Future<bool> hasPermission() => _recorder.hasPermission();

  @override
  Future<Stream<Uint8List>> startStream(RecordConfig config) {
    return _recorder.startStream(config);
  }

  @override
  Future<void> stop() => _recorder.stop();

  @override
  Future<void> dispose() => _recorder.dispose();
}

/// PCM 采集：16 kHz、mono、signed PCM16 little-endian。
final class RecordVoiceAudioCapture implements VoiceAudioCapture {
  RecordVoiceAudioCapture({VoiceRecorderAdapter? recorder})
    : _recorder = recorder ?? RecordRecorderAdapter();

  /// 固定配置；不设置文件路径，也不启用任何后处理。
  static const RecordConfig config = RecordConfig(
    encoder: AudioEncoder.pcm16bits,
    sampleRate: 16000,
    numChannels: 1,
    autoGain: false,
    echoCancel: false,
    noiseSuppress: false,
  );

  final VoiceRecorderAdapter _recorder;

  @override
  Future<bool> hasPermission() => _recorder.hasPermission();

  @override
  Future<Stream<Uint8List>> start() => _recorder.startStream(config);

  @override
  Future<void> stop() => _recorder.stop();

  @override
  Future<void> dispose() => _recorder.dispose();
}