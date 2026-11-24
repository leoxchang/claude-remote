import 'dart:convert';

import 'package:claude_remote/data/cloud_api.dart';
import 'package:claude_remote/data/credential_store.dart';
import 'package:claude_remote/data/device_credential.dart';
import 'package:claude_remote/features/cloud/cloud_login_controller.dart';
import 'package:claude_remote/features/pairing/pairing_controller.dart'
    show credentialStoreProvider;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import '../approvals/approval_test_support.dart' show MemoryVault;

http.Response loginSuccess() {
  return http.Response(
    jsonEncode({
      'accountId': 'acc_1',
      'deviceId': 'dev_phone1',
      'deviceToken': 'tok_1',
      'role': 'phone',
      'contractVersion': 1,
    }),
    200,
  );
}

http.Response errorResponse(String code, int status) {
  return http.Response(
    jsonEncode({
      'error': {'code': code, 'message': code},
    }),
    status,
  );
}

void main() {
  test('successful login stores a cloud credential without a desktop', () async {
    final vault = MemoryVault();
    var calls = 0;
    final container = ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(CredentialStore(vault)),
        cloudPlatformProvider.overrideWithValue('ios'),
        cloudApiProvider.overrideWithValue(
          CloudApi(
            client: MockClient((request) async {
              calls += 1;
              return loginSuccess();
            }),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);

    final credential = await container
        .read(cloudLoginControllerProvider.notifier)
        .submit(
          relayUrl: 'relay.example.com',
          username: 'alice',
          password: 'secret',
        );

    expect(calls, 1);
    expect(credential?.deviceId, 'dev_phone1');
    expect(credential?.deviceToken, 'tok_1');
    expect(credential?.mode, ConnectionMode.cloud);
    expect(credential?.desktopId, isNull);
    expect(credential?.baseUrl, 'https://relay.example.com');
    final stored = await CredentialStore(vault).read();
    expect(stored?.mode, ConnectionMode.cloud);
    expect(stored?.deviceToken, 'tok_1');
    expect(
      container.read(cloudLoginControllerProvider).status,
      CloudLoginStatus.success,
    );
  });

  test('invalid credentials fail with a safe message and store nothing', () async {
    final vault = MemoryVault();
    final container = ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(CredentialStore(vault)),
        cloudPlatformProvider.overrideWithValue('ios'),
        cloudApiProvider.overrideWithValue(
          CloudApi(
            client: MockClient(
              (_) async => errorResponse('INVALID_CREDENTIALS', 401),
            ),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);

    final credential = await container
        .read(cloudLoginControllerProvider.notifier)
        .submit(
          relayUrl: 'https://relay.example.com',
          username: 'alice',
          password: 'bad',
        );

    expect(credential, isNull);
    expect(await CredentialStore(vault).read(), isNull);
    final state = container.read(cloudLoginControllerProvider);
    expect(state.status, CloudLoginStatus.failed);
    expect(state.message, '账号或口令不正确');
  });

  test('an invalid relay url never reaches the network', () async {
    final vault = MemoryVault();
    var calls = 0;
    final container = ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(CredentialStore(vault)),
        cloudPlatformProvider.overrideWithValue('ios'),
        cloudApiProvider.overrideWithValue(
          CloudApi(
            client: MockClient((_) async {
              calls += 1;
              return loginSuccess();
            }),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);

    final credential = await container
        .read(cloudLoginControllerProvider.notifier)
        .submit(
          relayUrl: 'https://relay.example.com/api',
          username: 'alice',
          password: 'secret',
        );

    expect(credential, isNull);
    expect(calls, 0);
    expect(container.read(cloudLoginControllerProvider).message, contains('云端地址无效'));
  });
}
