import 'package:claude_remote/connection/connection_controller.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_test/flutter_test.dart';

import 'fake_socket.dart';

void main() {
  late FakeSocketFactory factory;
  late List<Duration> delays;
  late int readyCalls;

  ConnectionController buildController() {
    return ConnectionController(
      socketFactory: factory.call,
      deviceId: 'device_01',
      appVersion: '1.0.0',
      onReady: () async {
        readyCalls += 1;
      },
      delay: (duration) async {
        delays.add(duration);
      },
      jitter: () => Duration.zero,
    );
  }

  setUp(() {
    factory = FakeSocketFactory();
    delays = <Duration>[];
    readyCalls = 0;
  });

  test('sends connection.hello and becomes ready after connection.ready', () async {
    final controller = buildController();
    final connecting = controller.connect();
    await pumpEventQueue();

    final socket = factory.sockets.single;
    expect(socket.sent, hasLength(1));
    expect(socket.sent.single, contains('connection.hello'));
    expect(socket.sent.single, contains('device_01'));

    socket.emitMessage(readyMessage());
    await connecting;

    expect(controller.status, ConnectionStatus.ready);
    expect(controller.connectionEpoch, 1);
    expect(readyCalls, 1);
  });

  test('reconnects with the 1/2/4/8/15 second backoff', () async {
    final controller = buildController();
    unawaitedConnect(controller);
    await pumpEventQueue();

    for (var attempt = 0; attempt < 6; attempt += 1) {
      await factory.sockets.last.close();
      await pumpEventQueue();
    }

    expect(
      delays.map((duration) => duration.inSeconds).toList(),
      [1, 2, 4, 8, 15, 15],
    );
    expect(factory.sockets.length, 7);
  });

  test('does not reconnect while the app is in the background', () async {
    final controller = buildController();
    unawaitedConnect(controller);
    await pumpEventQueue();

    controller.onLifecycle(AppLifecycleState.paused);
    await factory.sockets.single.close();
    await pumpEventQueue();

    expect(factory.sockets, hasLength(1));
    expect(delays, isEmpty);

    controller.onLifecycle(AppLifecycleState.resumed);
    await pumpEventQueue();

    expect(factory.sockets, hasLength(2));
  });

  test('dispose closes the socket and stops reconnecting', () async {
    final controller = buildController();
    unawaitedConnect(controller);
    await pumpEventQueue();

    final socket = factory.sockets.single;
    await controller.dispose();
    await pumpEventQueue();

    expect(socket.closed, isTrue);
    expect(factory.sockets, hasLength(1));
    expect(delays, isEmpty);
  });
}

void unawaitedConnect(ConnectionController controller) {
  controller.connect();
}