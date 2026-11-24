import 'dart:convert';

import 'package:claude_remote/data/cloud_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('login posts the contract body and parses the device session', () async {
    late http.Request seen;
    final client = MockClient((request) async {
      seen = request;
      return http.Response(
        jsonEncode({
          'accountId': 'acc_1',
          'deviceId': 'dev_phone1',
          'deviceToken': 'tok_1',
          'role': 'phone',
          'contractVersion': 1,
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    final api = CloudApi(client: client);
    final result = await api.login(
      baseUrl: 'https://relay.example.com/',
      username: 'alice',
      password: 'secret',
      deviceName: 'iPhone',
      platform: 'ios',
      appVersion: '1.0.0',
    );
    expect(seen.method, 'POST');
    expect(seen.url.toString(), 'https://relay.example.com/v1/auth/login');
    expect(jsonDecode(seen.body), {
      'username': 'alice',
      'password': 'secret',
      'clientType': 'phone',
      'deviceName': 'iPhone',
      'platform': 'ios',
      'appVersion': '1.0.0',
    });
    expect(result.deviceId, 'dev_phone1');
    expect(result.deviceToken, 'tok_1');
    expect(result.role, 'phone');
    expect(result.contractVersion, 1);
  });

  test('login maps contract errors and rejects wrong contract version', () async {
    Future<String> codeFor(http.Response response) async {
      final api = CloudApi(client: MockClient((_) async => response));
      try {
        await api.login(
          baseUrl: 'https://relay.example.com',
          username: 'alice',
          password: 'bad',
          deviceName: 'iPhone',
          platform: 'ios',
          appVersion: '1.0.0',
        );
        return 'ok';
      } on CloudApiException catch (error) {
        return error.code;
      }
    }

    String errorBody(String code) =>
        jsonEncode({'error': {'code': code, 'message': code}});

    expect(
      await codeFor(http.Response(errorBody('INVALID_CREDENTIALS'), 401)),
      'INVALID_CREDENTIALS',
    );
    expect(
      await codeFor(http.Response(errorBody('ACCOUNT_DISABLED'), 403)),
      'ACCOUNT_DISABLED',
    );
    expect(
      await codeFor(http.Response(errorBody('DEVICE_LIMIT_REACHED'), 409)),
      'DEVICE_LIMIT_REACHED',
    );
    expect(
      await codeFor(http.Response(errorBody('RATE_LIMITED'), 429)),
      'RATE_LIMITED',
    );
    expect(
      await codeFor(http.Response('<html>bad gateway</html>', 502)),
      'REQUEST_FAILED',
    );
    expect(
      await codeFor(http.Response(jsonEncode({'role': 'phone'}), 200)),
      'INVALID_RESPONSE',
    );
    expect(
      await codeFor(
        http.Response(
          jsonEncode({
            'accountId': 'acc_1',
            'deviceId': 'dev_phone1',
            'deviceToken': 'tok_1',
            'role': 'phone',
            'contractVersion': 2,
          }),
          200,
        ),
      ),
      'VERSION_INCOMPATIBLE',
    );
  });

  test('network failures surface as NETWORK without leaking credentials', () async {
    final api = CloudApi(
      client: MockClient((_) async => throw http.ClientException('boom')),
    );
    try {
      await api.login(
        baseUrl: 'https://relay.example.com',
        username: 'alice',
        password: 'secret',
        deviceName: 'iPhone',
        platform: 'ios',
        appVersion: '1.0.0',
      );
      fail('expected CloudApiException');
    } on CloudApiException catch (error) {
      expect(error.code, 'NETWORK');
      expect(error.toString(), isNot(contains('secret')));
    }
  });

  test('listDesktops sends bearer auth and parses nullable fields', () async {
    late http.Request seen;
    final client = MockClient((request) async {
      seen = request;
      return http.Response(
        jsonEncode({
          'desktops': [
            {
              'desktopId': 'dev_desk1',
              'desktopName': 'MacBook Pro',
              'platform': 'macos',
              'appVersion': '1.0.0',
              'online': true,
              'lastSeenAt': 1763890000000,
            },
            {
              'desktopId': 'dev_desk2',
              'desktopName': 'Mac mini',
              'platform': 'macos',
              'appVersion': '1.0.0',
              'online': false,
              'lastSeenAt': null,
            },
            {'desktopName': 'broken entry'},
          ],
        }),
        200,
      );
    });
    final desktops = await CloudApi(client: client).listDesktops(
      baseUrl: 'https://relay.example.com',
      deviceId: 'dev_phone1',
      deviceToken: 'tok_1',
    );
    expect(seen.method, 'GET');
    expect(seen.url.toString(), 'https://relay.example.com/v1/desktops');
    expect(seen.headers['Authorization'], 'Bearer dev_phone1.tok_1');
    expect(desktops.length, 2);
    expect(desktops.first.desktopId, 'dev_desk1');
    expect(desktops.first.online, isTrue);
    expect(desktops.first.lastSeenAt, 1763890000000);
    expect(desktops.last.online, isFalse);
    expect(desktops.last.lastSeenAt, isNull);
  });

  test('listDesktops rejects malformed envelopes and revoked tokens', () async {
    Future<Object> run(http.Response response) async {
      try {
        return await CloudApi(
          client: MockClient((_) async => response),
        ).listDesktops(
          baseUrl: 'https://relay.example.com',
          deviceId: 'dev_phone1',
          deviceToken: 'tok_1',
        );
      } on CloudApiException catch (error) {
        return error.code;
      }
    }

    expect(await run(http.Response('{"desktops":{}}', 200)), 'INVALID_RESPONSE');
    expect(
      await run(http.Response('{"desktops":"nope"}', 200)),
      'INVALID_RESPONSE',
    );
    expect(
      await run(
        http.Response(
          '{"error":{"code":"UNAUTHENTICATED","message":"UNAUTHENTICATED"}}',
          401,
        ),
      ),
      'UNAUTHENTICATED',
    );
  });

  test('revokeDevice deletes the device with bearer auth', () async {
    late http.Request seen;
    final client = MockClient((request) async {
      seen = request;
      return http.Response('', 204);
    });
    await CloudApi(client: client).revokeDevice(
      baseUrl: 'https://relay.example.com',
      deviceId: 'dev_phone1',
      deviceToken: 'tok_1',
      targetDeviceId: 'dev_phone1',
    );
    expect(seen.method, 'DELETE');
    expect(
      seen.url.toString(),
      'https://relay.example.com/v1/devices/dev_phone1',
    );
    expect(seen.headers['Authorization'], 'Bearer dev_phone1.tok_1');
  });

  test('unexpected transport exceptions surface as NETWORK', () async {
    final api = CloudApi(
      client: MockClient((_) async => throw Exception('boom')),
    );
    try {
      await api.listDesktops(
        baseUrl: 'https://relay.example.com',
        deviceId: 'dev_phone1',
        deviceToken: 'tok_1',
      );
      fail('expected CloudApiException');
    } on CloudApiException catch (error) {
      expect(error.code, 'NETWORK');
    }
  });

  test('normalizeRelayBaseUrl accepts hosts and rejects paths and schemes', () {
    expect(
      normalizeRelayBaseUrl(' relay.example.com '),
      'https://relay.example.com',
    );
    expect(
      normalizeRelayBaseUrl('https://relay.example.com/'),
      'https://relay.example.com',
    );
    expect(
      normalizeRelayBaseUrl('http://127.0.0.1:8788'),
      'http://127.0.0.1:8788',
    );
    expect(
      normalizeRelayBaseUrl('http://192.168.5.10:8788'),
      'http://192.168.5.10:8788',
    );
    for (final raw in [
      '',
      'https://relay.example.com/api',
      'ftp://relay.example.com',
      'https://user:pass@relay.example.com',
      'https://relay.example.com?x=1',
      'http://relay.example.com',
    ]) {
      expect(
        () => normalizeRelayBaseUrl(raw),
        throwsA(
          isA<CloudApiException>().having((e) => e.code, 'code', 'INVALID_URL'),
        ),
        reason: raw,
      );
    }
  });
}
