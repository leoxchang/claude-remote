import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:web_socket_channel/io.dart';

import '../data/device_credential.dart';

/// Mac→App 的 ASR 事件。
sealed class AsrServerEvent {
  const AsrServerEvent();
}

final class AsrStarted extends AsrServerEvent {
  const AsrStarted({required this.asrStreamId});
  final String asrStreamId;
}

final class AsrPartial extends AsrServerEvent {
  const AsrPartial({
    required this.asrStreamId,
    required this.sequence,
    required this.text,
  });
  final String asrStreamId;
  final int sequence;
  final String text;
}

final class AsrFinal extends AsrServerEvent {
  const AsrFinal({
    required this.asrStreamId,
    required this.sequence,
    required this.text,
  });
  final String asrStreamId;
  final int sequence;
  final String text;
}

final class AsrServerError extends AsrServerEvent {
  const AsrServerError({
    required this.asrStreamId,
    required this.code,
    required this.retryable,
    required this.safeMessage,
  });
  final String asrStreamId;
  final String code;
  final bool retryable;
  final String safeMessage;
}

final class AsrCancelled extends AsrServerEvent {
  const AsrCancelled({required this.asrStreamId, required this.reason});
  final String asrStreamId;
  final String reason;
}

final class AsrClosed extends AsrServerEvent {
  const AsrClosed({required this.asrStreamId, required this.reason});
  final String asrStreamId;
  final String reason;
}

/// 一条音频连接；一次录音一条连接、一个流。
abstract interface class VoiceAsrConnection {
  Stream<AsrServerEvent> get events;
  Future<void> sendStart({required String asrStreamId});
  void sendAudio(Uint8List pcm);
  void sendFinish();
  void sendCancel();
  Future<void> close();
}

/// 连接工厂；测试注入 fake。
abstract interface class VoiceAsrClientFactory {
  Future<VoiceAsrConnection> connect();
}

/// 连接失败；只暴露安全文案。
final class VoiceAsrConnectionException implements Exception {
  const VoiceAsrConnectionException(this.code);
  final String code;
}

/// 最小 socket 抽象；生产由 IOWebSocketChannel 实现。
abstract interface class VoiceSocketChannel {
  Future<void> get ready;
  Stream<dynamic> get stream;
  void addText(String text);
  void addBinary(List<int> bytes);
  Future<void> close();
}

typedef VoiceChannelOpener =
    VoiceSocketChannel Function(Uri uri, Map<String, String> headers);

/// 真实 `/ws/asr` 工厂；token 只放 Authorization 头。
final class IoVoiceAsrClientFactory implements VoiceAsrClientFactory {
  IoVoiceAsrClientFactory({
    required this.credential,
    VoiceChannelOpener? openChannel,
  }) : _open = openChannel ?? _openIo;

  static const Duration connectTimeout = Duration(seconds: 10);
  static const Duration pingInterval = Duration(seconds: 15);

  final DeviceCredential credential;
  final VoiceChannelOpener _open;

  @override
  Future<VoiceAsrConnection> connect() async {
    final base = Uri.parse(credential.baseUrl);
    final uri = base.replace(scheme: 'wss', path: '/ws/asr');
    final channel = _open(uri, {
      'Authorization': 'Bearer ${credential.deviceToken}',
    });
    return IoVoiceAsrConnection(channel);
  }

  static VoiceSocketChannel _openIo(
    Uri uri,
    Map<String, String> headers,
  ) {
    return IoVoiceSocketChannel(
      IOWebSocketChannel.connect(
        uri,
        headers: headers,
        pingInterval: pingInterval,
        connectTimeout: connectTimeout,
      ),
    );
  }
}

/// IOWebSocketChannel 适配器。
final class IoVoiceSocketChannel implements VoiceSocketChannel {
  IoVoiceSocketChannel(this._channel);

  final IOWebSocketChannel _channel;

  @override
  Future<void> get ready => _channel.ready;

  @override
  Stream<dynamic> get stream => _channel.stream;

  @override
  void addText(String text) => _channel.sink.add(text);

  @override
  void addBinary(List<int> bytes) => _channel.sink.add(bytes);

  @override
  Future<void> close() => _channel.sink.close();
}

/// 单连接客户端：JSON 控制 + 二进制 PCM，最多排队 20 包。
final class IoVoiceAsrConnection implements VoiceAsrConnection {
  IoVoiceAsrConnection(this._channel) {
    _channel.ready.then(
      (_) => _onReady(),
      onError: (Object _) => _onSocketClosed(),
    );
    _subscription = _channel.stream.listen(
      _onData,
      onError: (Object _) => _onSocketClosed(),
      onDone: _onSocketClosed,
      cancelOnError: true,
    );
  }

  static const int maxQueuedAudio = 20;
  static const int maxSequenceJump = 1000;

  final VoiceSocketChannel _channel;
  final StreamController<AsrServerEvent> _events =
      StreamController<AsrServerEvent>.broadcast();
  final List<Uint8List> _queued = [];
  StreamSubscription<dynamic>? _subscription;
  bool _ready = false;
  bool _closed = false;
  bool _terminal = false;
  String? _streamId;
  int _messageCounter = 0;
  int _lastSequence = 0;

  @override
  Stream<AsrServerEvent> get events => _events.stream;

  @override
  Future<void> sendStart({required String asrStreamId}) async {
    _streamId = asrStreamId;
    await _awaitReady();
    _sendControl('asr.start', asrStreamId, {
      'audio': {'format': 'pcm-s16le', 'sampleRate': 16000, 'channels': 1},
    });
  }

  @override
  void sendAudio(Uint8List pcm) {
    if (_closed || _terminal) return;
    if (_ready) {
      _channel.addBinary(pcm);
      return;
    }
    if (_queued.length >= maxQueuedAudio) {
      _emit(
        AsrServerError(
          asrStreamId: _streamId ?? '',
          code: 'ASR_BACKPRESSURE',
          retryable: true,
          safeMessage: 'ASR_BACKPRESSURE',
        ),
      );
      _terminal = true;
      unawaited(close());
      return;
    }
    _queued.add(pcm);
  }

  @override
  void sendFinish() {
    if (_closed || _terminal) return;
    _sendControl('asr.finish', _streamId ?? '', const {});
  }

  @override
  void sendCancel() {
    if (_closed || _terminal) return;
    _terminal = true;
    _sendControl('asr.cancel', _streamId ?? '', const {});
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    unawaited(_subscription?.cancel());
    _subscription = null;
    await _channel.close();
    await _events.close();
  }

  void _onReady() {
    _ready = true;
    if (_closed) return;
    final queued = List<Uint8List>.from(_queued);
    _queued.clear();
    for (final chunk in queued) {
      _channel.addBinary(chunk);
    }
  }

  void _sendControl(
    String type,
    String asrStreamId,
    Map<String, Object?> payload,
  ) {
    _messageCounter += 1;
    _channel.addText(
      jsonEncode({
        'protocolVersion': 1,
        'messageId': 'asr_msg_$_messageCounter',
        'timestamp': DateTime.now().millisecondsSinceEpoch,
        'type': type,
        'asrStreamId': asrStreamId,
        'payload': payload,
      }),
    );
  }

  void _onData(dynamic data) {
    if (_closed || data is! String) return;
    final Object? decoded;
    try {
      decoded = jsonDecode(data);
    } on FormatException {
      return;
    }
    if (decoded is! Map<String, Object?>) return;
    final event = _decode(decoded);
    if (event == null) return;
    if (event is AsrClosed) {
      _closed = true;
      _emit(event);
      unawaited(_events.close());
      return;
    }
    _emit(event);
  }

  AsrServerEvent? _decode(Map<String, Object?> message) {
    final type = message['type'];
    final streamId = message['asrStreamId'];
    if (type is! String || streamId is! String) return null;
    switch (type) {
      case 'asr.started':
        return AsrStarted(asrStreamId: streamId);
      case 'asr.partial':
        return _decodeText(message, streamId, finalEvent: false);
      case 'asr.final':
        final event = _decodeText(message, streamId, finalEvent: true);
        if (event is AsrFinal) _terminal = true;
        return event;
      case 'asr.error':
        final code = message['code'];
        final retryable = message['retryable'];
        final safeMessage = message['safeMessage'];
        if (code is! String || retryable is! bool || safeMessage is! String) {
          return null;
        }
        _terminal = true;
        return AsrServerError(
          asrStreamId: streamId,
          code: code,
          retryable: retryable,
          safeMessage: safeMessage,
        );
      case 'asr.cancelled':
        final reason = message['reason'];
        if (reason is! String) return null;
        _terminal = true;
        return AsrCancelled(asrStreamId: streamId, reason: reason);
      case 'asr.closed':
        final reason = message['reason'];
        if (reason is! String) return null;
        return AsrClosed(asrStreamId: streamId, reason: reason);
      default:
        return null;
    }
  }

  AsrServerEvent? _decodeText(
    Map<String, Object?> message,
    String streamId, {
    required bool finalEvent,
  }) {
    final sequence = message['sequence'];
    final text = message['text'];
    if (sequence is! int || text is! String || sequence <= 0) return null;
    if (sequence <= _lastSequence) return null;
    if (sequence - _lastSequence > maxSequenceJump) return null;
    _lastSequence = sequence;
    return finalEvent
        ? AsrFinal(asrStreamId: streamId, sequence: sequence, text: text)
        : AsrPartial(asrStreamId: streamId, sequence: sequence, text: text);
  }

  Future<void> _awaitReady() async {
    if (_ready) return;
    try {
      await _channel.ready;
      _ready = true;
    } on Object {
      throw const VoiceAsrConnectionException('ASR_CONNECTION_FAILED');
    }
    if (_closed) {
      throw const VoiceAsrConnectionException('ASR_CONNECTION_FAILED');
    }
  }

  void _onSocketClosed() {
    if (_closed) return;
    _closed = true;
    _emit(
      AsrClosed(
        asrStreamId: _streamId ?? '',
        reason: 'socket_closed',
      ),
    );
    unawaited(_events.close());
  }

  void _emit(AsrServerEvent event) {
    if (_events.isClosed) return;
    _events.add(event);
  }
}