import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:claude_remote/data/device_credential.dart';
import 'package:claude_remote/voice/voice_asr_client.dart';

class FakeChannel implements VoiceSocketChannel {
  final Completer<void> _ready = Completer<void>();
  final StreamController<dynamic> _stream =
      StreamController<dynamic>.broadcast();
  final List<String> texts = [];
  final List<List<int>> binaries = [];
  bool closed = false;

  @override
  Future<void> get ready => _ready.future;

  @override
  Stream<dynamic> get stream => _stream.stream;

  @override
  void addText(String text) {
    texts.add(text);
  }

  @override
  void addBinary(List<int> bytes) {
    binaries.add(bytes);
  }

  @override
  Future<void> close() async {
    closed = true;
  }

  void open() {
    if (!_ready.isCompleted) _ready.complete();
  }

  void receive(Map<String, Object?> message) {
    _stream.add(jsonEncode(message));
  }

  void receiveRaw(Object? value) {
    _stream.add(value);
  }

  void end() {
    _stream.close();
  }
}

const credential = DeviceCredential(
  deviceId: 'device_1',
  deviceToken: 'secret_token',
  baseUrl: 'https://mac.example.ts.net',
);

Future<void> settle() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
}

void main() {
  group('IoVoiceAsrClientFactory', () {
    test('uses wss /ws/asr with the token only in Authorization', () async {
      late Uri uri;
      late Map<String, String> headers;
      final channel = FakeChannel();
      final factory = IoVoiceAsrClientFactory(
        credential: credential,
        openChannel: (openedUri, openedHeaders) {
          uri = openedUri;
          headers = openedHeaders;
          return channel;
        },
      );
      await factory.connect();
      expect(uri.toString(), 'wss://mac.example.ts.net/ws/asr');
      expect(headers, {'Authorization': 'Bearer device_1.secret_token'});
      expect(uri.toString(), isNot(contains('secret_token')));
    });

    test('uses ws /ws/asr for a LAN http credential', () async {
      late Uri uri;
      final channel = FakeChannel();
      final factory = IoVoiceAsrClientFactory(
        credential: const DeviceCredential(
          deviceId: 'device_1',
          deviceToken: 'secret_token',
          baseUrl: 'http://192.168.5.10:8787',
        ),
        openChannel: (openedUri, _) {
          uri = openedUri;
          return channel;
        },
      );
      await factory.connect();

      expect(uri.toString(), 'ws://192.168.5.10:8787/ws/asr');
    });

    test('cloud mode routes the asr channel to the selected desktop', () async {
      late Uri uri;
      final channel = FakeChannel();
      final factory = IoVoiceAsrClientFactory(
        credential: const DeviceCredential(
          deviceId: 'device_1',
          deviceToken: 'secret_token',
          baseUrl: 'https://relay.example.com',
          desktopId: 'dev_desk1',
          mode: ConnectionMode.cloud,
        ),
        openChannel: (openedUri, _) {
          uri = openedUri;
          return channel;
        },
      );
      await factory.connect();

      expect(uri.path, '/ws/asr');
      expect(uri.queryParameters['desktopId'], 'dev_desk1');
    });
  });

  group('IoVoiceAsrConnection', () {
    late FakeChannel channel;
    late IoVoiceAsrConnection connection;

    setUp(() {
      channel = FakeChannel();
      connection = IoVoiceAsrConnection(channel);
    });

    test('sends asr.start with fixed audio parameters only', () async {
      channel.open();
      await connection.sendStart(asrStreamId: 'asr_1');
      final message =
          jsonDecode(channel.texts.single) as Map<String, Object?>;
      expect(message['protocolVersion'], 1);
      expect(message['type'], 'asr.start');
      expect(message['asrStreamId'], 'asr_1');
      expect(message['messageId'], isA<String>());
      expect(message['timestamp'], isA<int>());
      expect(message['payload'], {
        'audio': {'format': 'pcm-s16le', 'sampleRate': 16000, 'channels': 1},
      });
      expect(channel.texts.single, isNot(contains('secret_token')));
      expect(channel.texts.single, isNot(contains('endpoint')));
    });

    test('queues audio before ready and flushes it in order', () async {
      connection.sendAudio(Uint8List.fromList([1, 2]));
      connection.sendAudio(Uint8List.fromList([3, 4]));
      expect(channel.binaries, isEmpty);
      channel.open();
      await settle();
      expect(channel.binaries, [
        [1, 2],
        [3, 4],
      ]);
    });

    test('fails with ASR_BACKPRESSURE after 20 queued packets', () async {
      final events = <AsrServerEvent>[];
      connection.events.listen(events.add);
      for (var index = 0; index < 21; index += 1) {
        connection.sendAudio(Uint8List.fromList([index, index]));
      }
      await settle();
      final error = events.whereType<AsrServerError>().single;
      expect(error.code, 'ASR_BACKPRESSURE');
      expect(channel.binaries, isEmpty);
    });

    test('sends finish and cancel as control messages', () async {
      channel.open();
      await connection.sendStart(asrStreamId: 'asr_1');
      connection.sendFinish();
      connection.sendCancel();
      final types = channel.texts
          .map((text) => (jsonDecode(text) as Map<String, Object?>)['type'])
          .toList();
      expect(types, ['asr.start', 'asr.finish', 'asr.cancel']);
      expect(channel.texts, hasLength(3));
    });

    test('decodes server events and drops stale sequences', () async {
      channel.open();
      await connection.sendStart(asrStreamId: 'asr_1');
      final events = <AsrServerEvent>[];
      connection.events.listen(events.add);

      channel.receive({'type': 'asr.started', 'asrStreamId': 'asr_1'});
      channel.receive({
        'type': 'asr.partial',
        'asrStreamId': 'asr_1',
        'sequence': 2,
        'text': '你好',
      });
      channel.receive({
        'type': 'asr.partial',
        'asrStreamId': 'asr_1',
        'sequence': 1,
        'text': '旧',
      });
      channel.receive({
        'type': 'asr.final',
        'asrStreamId': 'asr_1',
        'sequence': 3,
        'text': '你好。',
      });
      channel.receive({
        'type': 'asr.error',
        'asrStreamId': 'asr_1',
        'code': 'ASR_FINAL_TIMEOUT',
        'retryable': true,
        'safeMessage': 'ASR_FINAL_TIMEOUT',
      });
      channel.receive({
        'type': 'asr.unknown',
        'asrStreamId': 'asr_1',
      });
      await settle();

      expect(events.map((event) => event.runtimeType), [
        AsrStarted,
        AsrPartial,
        AsrFinal,
        AsrServerError,
      ]);
      expect((events[1] as AsrPartial).sequence, 2);
      expect((events[2] as AsrFinal).text, '你好。');
    });

    test('maps a socket close to AsrClosed socket_closed', () async {
      channel.open();
      await connection.sendStart(asrStreamId: 'asr_1');
      final events = <AsrServerEvent>[];
      connection.events.listen(events.add);
      channel.end();
      await settle();
      final closed = events.whereType<AsrClosed>().single;
      expect(closed.reason, 'socket_closed');
    });

    test('ignores binary and malformed server frames', () async {
      channel.open();
      await connection.sendStart(asrStreamId: 'asr_1');
      final events = <AsrServerEvent>[];
      connection.events.listen(events.add);
      channel.receiveRaw(Uint8List.fromList([1, 2]));
      channel.receiveRaw('not json');
      channel.receiveRaw(jsonEncode({'type': 'asr.partial'}));
      await settle();
      expect(events, isEmpty);
    });
  });
}