import 'dart:convert';
import 'dart:io';

import 'package:claude_remote/protocol/decoder.dart';
import 'package:claude_remote/protocol/envelope.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter_test/flutter_test.dart';

List<Map<String, dynamic>> readExamples(String file) {
  final raw = File('../../protocol/v1/examples/$file').readAsStringSync();
  return (jsonDecode(raw) as List<dynamic>).cast<Map<String, dynamic>>();
}

void main() {
  group('shared valid examples', () {
    final examples = readExamples('valid.json');

    for (final example in examples) {
      final name = example['name'] as String;
      final message = example['message'] as Map<String, dynamic>;

      test('decodes $name into the expected message class', () {
        final decoded = ProtocolDecoder.decode(jsonEncode(message));

        switch (name) {
          case 'command.result.ok':
          case 'command.result.duplicate':
            expect(decoded, isA<CommandResultMessage>());
          case 'session.status':
            expect(decoded, isA<TimelineEvent>());
          case 'error':
            expect(decoded, isA<ControlMessage>());
          default:
            expect(decoded, isA<CommandMessage>());
        }
      });
    }
  });

  group('shared invalid examples', () {
    final examples = readExamples('invalid.json');

    for (final example in examples) {
      final name = example['name'] as String;
      final message = example['message'] as Map<String, dynamic>;

      test('rejects $name with a safe error', () {
        late ProtocolDecodeException failure;
        try {
          ProtocolDecoder.decode(jsonEncode(message));
          fail('$name should have been rejected');
        } on ProtocolDecodeException catch (error) {
          failure = error;
        }

        expect(failure.code, isNotEmpty);
        expect(failure.path, isNotEmpty);
        expect(failure.toString(), isNot(contains('DO_NOT_LEAK_99')));
      });
    }
  });

  test('rejects malformed JSON without echoing the input', () {
    expect(
      () => ProtocolDecoder.decode('{"protocolVersion": 1, "secret": "DO_NOT_LEAK_99"'),
      throwsA(
        isA<ProtocolDecodeException>()
            .having((error) => error.code, 'code', 'INVALID_MESSAGE')
            .having(
              (error) => error.toString(),
              'message',
              isNot(contains('DO_NOT_LEAK_99')),
            ),
      ),
    );
  });
}