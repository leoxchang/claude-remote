import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:claude_remote/voice/pcm_packetizer.dart';

Uint8List bytes(int length, {int start = 0}) {
  return Uint8List.fromList(
    List<int>.generate(length, (index) => (start + index) % 256),
  );
}

void main() {
  group('PcmPacketizer', () {
    test('accumulates small chunks into 6,400-byte frames', () {
      final packetizer = PcmPacketizer();
      final output = <Uint8List>[];
      for (var index = 0; index < 640; index += 1) {
        output.addAll(packetizer.add(bytes(10, start: index)));
      }
      expect(output, hasLength(1));
      expect(output.single, hasLength(6400));
      expect(packetizer.flush(), isNull);
    });

    test('splits a large chunk without exceeding one packet', () {
      final packetizer = PcmPacketizer();
      final output = packetizer.add(bytes(10000));
      expect(output, hasLength(1));
      expect(output.single, hasLength(6400));
      final rest = packetizer.flush();
      expect(rest, hasLength(3600));
    });

    test('never emits odd-length frames and carries a half sample', () {
      final packetizer = PcmPacketizer();
      expect(packetizer.add(Uint8List.fromList([1])), isEmpty);
      expect(packetizer.flush(), isNull);
      expect(packetizer.add(Uint8List.fromList([2, 3])), isEmpty);
      expect(packetizer.flush(), Uint8List.fromList([1, 2]));
      expect(packetizer.add(Uint8List.fromList([4])), isEmpty);
      expect(packetizer.flush(), Uint8List.fromList([3, 4]));
    });

    test('only emits full frames and keeps remainders even', () {
      final packetizer = PcmPacketizer();
      final output = <Uint8List>[];
      for (var index = 0; index < 1281; index += 1) {
        output.addAll(packetizer.add(bytes(5, start: index)));
        for (final frame in output) {
          expect(frame.length.isEven, isTrue);
          expect(frame.length, lessThanOrEqualTo(6400));
        }
      }
      final rest = packetizer.flush();
      if (rest != null) {
        expect(rest.length.isEven, isTrue);
        expect(rest, isNotEmpty);
        expect(rest.length, lessThanOrEqualTo(6400));
      }
    });

    test('returns null when nothing is buffered', () {
      final packetizer = PcmPacketizer();
      expect(packetizer.flush(), isNull);
    });
  });
}