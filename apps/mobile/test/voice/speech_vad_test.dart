import 'package:flutter_test/flutter_test.dart';

import 'package:claude_remote/voice/speech_vad.dart';

const step = Duration(milliseconds: 100);

VadAction feed(
  SpeechVad vad,
  List<double> levels, {
  required Duration from,
}) {
  var action = VadAction.none;
  for (var index = 0; index < levels.length; index += 1) {
    final at = from + step * (index + 1);
    final next = vad.addSample(rmsDbfs: levels[index], at: at);
    if (next == VadAction.autoFinish) action = VadAction.autoFinish;
  }
  return action;
}

void main() {
  group('SpeechVad', () {
    test('never finishes on silence before speech is detected', () {
      final vad = SpeechVad();
      final levels = List<double>.filled(40, -60);
      expect(feed(vad, levels, from: Duration.zero), VadAction.none);
    });

    test('requires 500 ms of speech before detection', () {
      final vad = SpeechVad();
      expect(
        feed(vad, List<double>.filled(5, -30), from: Duration.zero),
        VadAction.none,
      );
      expect(vad.speechDetected, isFalse);
      expect(
        feed(vad, [-30], from: step * 5),
        VadAction.none,
      );
      expect(vad.speechDetected, isTrue);
    });

    test('auto-finishes after 1,500 ms of silence', () {
      final vad = SpeechVad();
      expect(
        feed(vad, List<double>.filled(6, -30), from: Duration.zero),
        VadAction.none,
      );
      expect(
        feed(vad, List<double>.filled(14, -60), from: step * 6),
        VadAction.none,
      );
      expect(
        feed(vad, [-60], from: step * 20),
        VadAction.autoFinish,
      );
      expect(vad.addSample(rmsDbfs: -60, at: step * 30), VadAction.none);
    });

    test('resets the silence timer when speech resumes', () {
      final vad = SpeechVad();
      feed(vad, List<double>.filled(6, -30), from: Duration.zero);
      feed(vad, List<double>.filled(10, -60), from: step * 6);
      feed(vad, [-30], from: step * 16);
      expect(
        feed(vad, List<double>.filled(14, -60), from: step * 17),
        VadAction.none,
      );
      expect(
        feed(vad, [-60], from: step * 31),
        VadAction.autoFinish,
      );
    });

    test('treats values between thresholds as neither speech nor silence', () {
      final vad = SpeechVad();
      feed(vad, List<double>.filled(6, -30), from: Duration.zero);
      expect(
        feed(vad, List<double>.filled(40, -42), from: step * 6),
        VadAction.none,
      );
    });
  });
}