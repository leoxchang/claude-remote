import 'dart:async';
import 'dart:math';

import 'package:flutter/widgets.dart' show AppLifecycleState;

import '../data/agent_socket.dart';
import '../protocol/decoder.dart';
import '../protocol/envelope.dart';
import '../protocol/messages.dart';

/// 连接状态；与 spec §13.2 的连接状态分开管理。
enum ConnectionStatus { disconnected, connecting, ready, reconnecting }

/// 可注入的等待实现，测试用它跳过真实退避时间。
typedef Delay = Future<void> Function(Duration duration);

/// 握手成功后的回调；由会话层决定 start 还是 snapshot。
typedef ReadyHandler = Future<void> Function();

/// Agent 实例变化回调；`previous` 为 null 表示首次连接。
typedef AgentInstanceHandler = void Function(String? previous, String next);

final class ConnectionController {
  ConnectionController({
    required this.socketFactory,
    required this.deviceId,
    required this.appVersion,
    required this.onReady,
    this.onSocket,
    this.onStatus,
    this.onAgentInstanceChanged,
    this.onLifecycleHook,
    Delay? delay,
    Duration Function()? jitter,
    this.connectTimeout = const Duration(seconds: 10),
  }) : _delay = delay ?? _realDelay,
       _jitter = jitter ?? _randomJitter;

  /// spec §9 规定的重连间隔；超过 15 秒后保持 15 秒。
  static const List<int> backoffSeconds = [1, 2, 4, 8, 15];

  final AgentSocket Function() socketFactory;
  final String deviceId;
  final String appVersion;
  final ReadyHandler onReady;
  final void Function(AgentSocket socket)? onSocket;
  final void Function(ConnectionStatus status)? onStatus;
  final AgentInstanceHandler? onAgentInstanceChanged;
  /// 生命周期联动；审批控制器据此遮罩并清空正文。
  final void Function(AppLifecycleState state)? onLifecycleHook;
  final Duration connectTimeout;
  final Delay _delay;
  final Duration Function() _jitter;

  ConnectionStatus _status = ConnectionStatus.disconnected;
  int _epoch = 0;
  int _attempt = 0;
  bool _disposed = false;
  bool _paused = false;
  AgentSocket? _socket;
  String? _agentInstanceId;
  StreamSubscription<String>? _subscription;
  final StreamController<ProtocolMessage> _incoming =
      StreamController<ProtocolMessage>.broadcast();

  /// 解码后的入站消息；运行时就绪后据此更新会话与时间线。
  Stream<ProtocolMessage> get incoming => _incoming.stream;

  ConnectionStatus get status => _status;

  /// 当前 Agent 进程的实例标识；每次 Mac 重启都会变化。
  String? get agentInstanceId => _agentInstanceId;

  /// 每次成功升级连接都会递增；旧连接的回调据此丢弃。
  int get connectionEpoch => _epoch;

  Future<void> connect() async {
    if (_disposed || _status == ConnectionStatus.ready) return;
    _attempt = 0;
    await _open();
  }

  /// 退后台不发送 cancel，也不主动断开；回前台重新连接。
  void onLifecycle(AppLifecycleState state) {
    onLifecycleHook?.call(state);
    final paused =
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.detached;
    _paused = paused;
    if (!paused && !_disposed && _status != ConnectionStatus.ready) {
      _attempt = 0;
      unawaited(_open());
    }
  }

  Future<void> dispose() async {
    _disposed = true;
    await _subscription?.cancel();
    await _socket?.close();
    _setStatus(ConnectionStatus.disconnected);
    await _incoming.close();
  }

  Future<void> _open() async {
    if (_disposed) return;
    _setStatus(ConnectionStatus.connecting);
    final epoch = ++_epoch;
    final socket = socketFactory();
    _socket = socket;
    onSocket?.call(socket);
    final handshakeId = 'hs_$epoch';
    final ready = Completer<void>();
    _subscription = socket.messages.listen(
      (raw) => _onMessage(epoch, raw, ready),
      onError: (Object _) => unawaited(_drop(epoch)),
      onDone: () => unawaited(_drop(epoch)),
      cancelOnError: true,
    );
    await socket.send(_hello(handshakeId));
    try {
      await ready.future.timeout(connectTimeout);
    } on TimeoutException {
      await _drop(epoch);
      return;
    }
    if (_disposed || epoch != _epoch) return;
    _attempt = 0;
    _setStatus(ConnectionStatus.ready);
    await onReady();
  }

  void _onMessage(int epoch, String raw, Completer<void> ready) {
    if (_disposed || epoch != _epoch) return;
    final ProtocolMessage message;
    try {
      message = ProtocolDecoder.decode(raw);
    } on ProtocolDecodeException {
      return;
    }
    if (!_incoming.isClosed) _incoming.add(message);
    if (message.type == 'connection.ready') {
      _updateAgentInstance(message.payload['agentInstanceId']);
      if (!ready.isCompleted) ready.complete();
    }
  }

  /// 只在实际变化时回调；首次连接 previous 为 null。
  void _updateAgentInstance(Object? raw) {
    if (raw is! String || raw.isEmpty) return;
    final previous = _agentInstanceId;
    if (previous == raw) return;
    _agentInstanceId = raw;
    onAgentInstanceChanged?.call(previous, raw);
  }

  Future<void> _drop(int epoch) async {
    if (_disposed || epoch != _epoch) return;
    _setStatus(ConnectionStatus.reconnecting);
    await _subscription?.cancel();
    await _socket?.close();
    if (_paused) return;
    unawaited(_reconnect());
  }

  Future<void> _reconnect() async {
    final index = _attempt < backoffSeconds.length
        ? _attempt
        : backoffSeconds.length - 1;
    _attempt += 1;
    await _delay(Duration(seconds: backoffSeconds[index]) + _jitter());
    if (_disposed || _status == ConnectionStatus.ready || _paused) return;
    await _open();
  }

  void _setStatus(ConnectionStatus status) {
    _status = status;
    onStatus?.call(status);
  }

  ControlMessage _hello(String handshakeId) {
    return ControlMessage(
      messageId: 'msg_$handshakeId',
      timestamp: DateTime.now().millisecondsSinceEpoch,
      type: 'connection.hello',
      payload: {
        'supportedProtocolVersions': [1],
        'appVersion': appVersion,
        'deviceId': deviceId,
        'capabilities': ['text'],
        'handshakeId': handshakeId,
      },
    );
  }
}

Future<void> _realDelay(Duration duration) => Future<void>.delayed(duration);

final Random _random = Random();

Duration _randomJitter() =>
    Duration(milliseconds: _random.nextInt(250));