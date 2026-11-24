import 'package:claude_remote/data/device_credential.dart';
import 'package:claude_remote/data/providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../connection/fake_socket.dart';

const DeviceCredential cloudCredential = DeviceCredential(
  deviceId: 'dev_phone1',
  deviceToken: 'tok_1',
  baseUrl: 'https://relay.example.com',
  desktopId: 'dev_a',
  mode: ConnectionMode.cloud,
);

void main() {
  test('invalidating the credential closes the old control socket', () async {
    final sockets = <FakeAgentSocket>[];
    final container = ProviderContainer(
      overrides: [
        credentialProvider.overrideWith((ref) async => cloudCredential),
        readyAgentSocketProvider.overrideWithValue((credential) async {
          final socket = FakeAgentSocket();
          sockets.add(socket);
          return socket;
        }),
      ],
    );
    addTearDown(container.dispose);

    final client = await container.read(commandClientProvider.future);
    expect(client, isNotNull);

    container.invalidate(credentialProvider);
    await container.read(commandClientProvider.future);

    expect(sockets, hasLength(2));
    expect(sockets.first.closed, isTrue);
  });
}
