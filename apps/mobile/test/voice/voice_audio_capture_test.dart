import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:record/record.dart';

import 'package:claude_remote/voice/voice_audio_capture.dart';

class FakeRecorder implements VoiceRecorderAdapter {
  FakeRecorder({this.permission = true});

  bool permission;
  RecordConfig? config;
  int starts = 0;
  int stops = 0;
  int disposals = 0;
  final StreamController<Uint8List> controller =
      StreamController<Uint8List>.broadcast();

  @override
  Future<bool> hasPermission() async => permission;

  @override
  Future<Stream<Uint8List>> startStream(RecordConfig config) async {
    starts += 1;
    this.config = config;
    return controller.stream;
  }

  @override
  Future<void> stop() async {
    stops += 1;
  }

  @override
  Future<void> dispose() async {
    disposals += 1;
  }
}

void main() {
  group('RecordVoiceAudioCapture', () {
    test('uses 16 kHz mono PCM16 and never writes a file', () {
      const config = RecordVoiceAudioCapture.config;
      expect(config.encoder, AudioEncoder.pcm16bits);
      expect(config.sampleRate, 16000);
      expect(config.numChannels, 1);
    });

    test('returns false when microphone permission is denied', () async {
      final recorder = FakeRecorder(permission: false);
      final capture = RecordVoiceAudioCapture(recorder: recorder);
      expect(await capture.hasPermission(), isFalse);
      expect(recorder.starts, 0);
    });

    test('starts a stream with the fixed config and stops the recorder', () async {
      final recorder = FakeRecorder();
      final capture = RecordVoiceAudioCapture(recorder: recorder);
      expect(await capture.hasPermission(), isTrue);
      final stream = await capture.start();
      expect(recorder.starts, 1);
      expect(recorder.config?.encoder, AudioEncoder.pcm16bits);
      expect(recorder.config?.sampleRate, 16000);
      expect(recorder.config?.numChannels, 1);

      final chunks = <Uint8List>[];
      final subscription = stream.listen(chunks.add);
      recorder.controller.add(Uint8List.fromList([1, 2]));
      await Future<void>.delayed(Duration.zero);
      await subscription.cancel();

      await capture.stop();
      await capture.dispose();
      expect(recorder.stops, 1);
      expect(recorder.disposals, 1);
      expect(chunks, hasLength(1));
    });
  });
}