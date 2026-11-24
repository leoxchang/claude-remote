import 'package:claude_remote/data/device_credential.dart';
import 'package:flutter_test/flutter_test.dart';

const DeviceCredential directCredential = DeviceCredential(
  deviceId: 'dev_phone1',
  deviceToken: 'tok_secret',
  baseUrl: 'https://mac.example.ts.net',
  desktopId: 'dev_desk1',
);
const DeviceCredential cloudCredential = DeviceCredential(
  deviceId: 'dev_phone1',
  deviceToken: 'tok_secret',
  baseUrl: 'https://relay.example.com',
  desktopId: 'dev_desk1',
  mode: ConnectionMode.cloud,
);
const DeviceCredential cloudNoDesktop = DeviceCredential(
  deviceId: 'dev_phone1',
  deviceToken: 'tok_secret',
  baseUrl: 'https://relay.example.com',
  mode: ConnectionMode.cloud,
);

void main() {
  test('direct mode never adds desktopId and websocket uses wss for https', () {
    expect(
      directCredential.webSocketUri('/ws').toString(),
      'wss://mac.example.ts.net/ws',
    );
    expect(
      directCredential.httpUri('/v1/attachments').toString(),
      'https://mac.example.ts.net/v1/attachments',
    );
  });

  test('cloud mode appends desktopId to ws and http urls', () {
    expect(
      cloudCredential.webSocketUri('/ws/asr').toString(),
      'wss://relay.example.com/ws/asr?desktopId=dev_desk1',
    );
    expect(
      cloudCredential.httpUri('/v1/attachments').queryParameters['desktopId'],
      'dev_desk1',
    );
  });

  test('cloud mode merges query parameters and desktopId wins on conflict', () {
    final uri = cloudCredential.httpUri(
      '/v1/approvals/appr_1/content',
      const {'chunkIndex': '2', 'desktopId': 'dev_other'},
    );
    expect(uri.path, '/v1/approvals/appr_1/content');
    expect(uri.queryParameters['chunkIndex'], '2');
    expect(uri.queryParameters['desktopId'], 'dev_desk1');
  });

  test('cloud mode without selected desktop throws', () {
    expect(
      () => cloudNoDesktop.webSocketUri('/ws'),
      throwsA(isA<StateError>()),
    );
    expect(
      () => cloudNoDesktop.httpUri('/v1/attachments'),
      throwsA(isA<StateError>()),
    );
  });

  test('storageScope keeps direct on legacy null and sanitizes cloud ids', () {
    expect(directCredential.storageScope, isNull);
    expect(cloudNoDesktop.storageScope, 'cloud-unselected');
    const hostile = DeviceCredential(
      deviceId: 'd',
      deviceToken: 't',
      baseUrl: 'https://relay.example.com',
      desktopId: '../evil dir/x',
      mode: ConnectionMode.cloud,
    );
    expect(hostile.storageScope, isNot(contains('/')));
    expect(hostile.storageScope, isNot(contains('..')));
    expect(hostile.storageScope, startsWith('cloud-'));
  });

  test('fromJson defaults missing mode to direct and rejects unknown mode', () {
    expect(
      DeviceCredential.fromJson(const {
        'deviceId': 'd',
        'deviceToken': 't',
        'baseUrl': 'https://mac.example.ts.net',
      })?.mode,
      ConnectionMode.direct,
    );
    expect(
      DeviceCredential.fromJson(const {
        'deviceId': 'd',
        'deviceToken': 't',
        'baseUrl': 'https://relay.example.com',
        'mode': 'cloud',
      })?.mode,
      ConnectionMode.cloud,
    );
    expect(
      DeviceCredential.fromJson(const {
        'deviceId': 'd',
        'deviceToken': 't',
        'baseUrl': 'https://relay.example.com',
        'mode': 'satellite',
      }),
      isNull,
    );
  });

  test('withDesktop keeps identity and switches the routing target', () {
    final selected = cloudNoDesktop.withDesktop('dev_desk9');
    expect(selected.desktopId, 'dev_desk9');
    expect(selected.deviceId, cloudNoDesktop.deviceId);
    expect(selected.deviceToken, cloudNoDesktop.deviceToken);
    expect(selected.baseUrl, cloudNoDesktop.baseUrl);
    expect(selected.mode, ConnectionMode.cloud);
  });
}
