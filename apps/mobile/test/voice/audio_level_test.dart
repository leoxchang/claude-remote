import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:claude_remote/voice/audio_level.dart';

Uint8List pcm16(List<int> samples) {
  final data = ByteData(samples.length * 2);
  for (var index = 0; index < samples.length; index += 1) {
    data.setInt16(index * 2, samples[index], Endian.little);
  }
  return data.buffer.asUint8List();
}

void main() {
  group('rmsDbfsPcm16', () {
    test('returns the floor for silence and empty input', () {
      expect(rmsDbfsPcm16(pcm16([0, 0, 0, 0])), -96);
      expect(rmsDbfsPcm16(Uint8List(0)), -96);
      expect(rmsDbfsPcm16(Uint8List.fromList([1])), -96);
    });

    test('returns about 0 dBFS for full-scale samples', () {
      expect(rmsDbfsPcm16(pcm16([32767, -32768])), closeTo(0, 0.1));
    });

    test('returns about -6 dBFS for half-scale samples', () {
      expect(rmsDbfsPcm16(pcm16([16384, -16384])), closeTo(-6.02, 0.1));
    });
  });
}