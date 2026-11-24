import 'package:claude_remote/data/device_credential.dart';
import 'package:claude_remote/data/io_agent_socket.dart';
import 'package:flutter_test/flutter_test.dart';

const DeviceCredential lanCredential = DeviceCredential(
  deviceId: 'device_1',
  deviceToken: 'secret_token',
  baseUrl: 'http://192.168.5.10:8787',
);

const DeviceCredential tunnelCredential = DeviceCredential(
  deviceId: 'device_1',
  deviceToken: 'secret_token',
  baseUrl: 'https://mac.example.ts.net',
);

void main() {
  test('uses ws for LAN http and wss for https', () {
    expect(
      agentSocketUri(lanCredential).toString(),
      'ws://192.168.5.10:8787/ws',
    );
    expect(
      agentSocketUri(tunnelCredential).toString(),
      'wss://mac.example.ts.net/ws',
    );
  });

  test('sends device id and token in the bearer header', () {
    expect(agentSocketHeaders(lanCredential), {
      'Authorization': 'Bearer device_1.secret_token',
    });
  });

  test('cloud mode targets the selected desktop through the relay', () {
    expect(
      agentSocketUri(
        const DeviceCredential(
          deviceId: 'device_1',
          deviceToken: 'secret_token',
          baseUrl: 'https://relay.example.com',
          desktopId: 'dev_desk1',
          mode: ConnectionMode.cloud,
        ),
      ).toString(),
      'wss://relay.example.com/ws?desktopId=dev_desk1',
    );
  });
}