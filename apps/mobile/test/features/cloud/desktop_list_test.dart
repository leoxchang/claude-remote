import 'dart:convert';
import 'dart:io';

import 'package:claude_remote/data/cloud_api.dart';
import 'package:claude_remote/data/credential_store.dart';
import 'package:claude_remote/data/device_credential.dart';
import 'package:claude_remote/data/recovery_providers.dart';
import 'package:claude_remote/features/cloud/cloud_login_controller.dart';
import 'package:claude_remote/features/cloud/desktop_list_controller.dart';
import 'package:claude_remote/features/pairing/pairing_controller.dart'
    show credentialStoreProvider;
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../approvals/approval_test_support.dart' show MemoryVault;

const DeviceCredential cloudCredential = DeviceCredential(
  deviceId: 'dev_phone1',
  deviceToken: 'tok_1',
  baseUrl: 'https://relay.example.com',
  mode: ConnectionMode.cloud,
);

http.Response desktopsResponse() {
  return http.Response(
    jsonEncode({
      'desktops': [
        {
          'desktopId': 'dev_a',
          'desktopName': 'MacBook Pro',
          'platform': 'macos',
          'appVersion': '1.0.0',
          'online': true,
          'lastSeenAt': 1763890000000,
        },
        {
          'desktopId': 'dev_b',
          'desktopName': 'Mac mini',
          'platform': 'macos',
          'appVersion': '1.0.0',
          'online': false,
          'lastSeenAt': null,
        },
      ],
    }),
    200,
  );
}

void main() {
  sqfliteFfiInit();

  late MemoryVault vault;
  late RecoveryStore store;
  late ProviderContainer container;

  ProviderContainer buildContainer(http.Client client) {
    return ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(CredentialStore(vault)),
        cloudApiProvider.overrideWithValue(CloudApi(client: client)),
        recoveryStoreProvider.overrideWith((ref) async => store),
      ],
    );
  }

  setUp(() async {
    vault = MemoryVault();
    await CredentialStore(vault).save(cloudCredential);
    final dir = await Directory.systemTemp.createTemp('desktop-list-');
    addTearDown(() => dir.delete(recursive: true));
    store = await RecoveryStore.open(
      factory: databaseFactoryFfi,
      supportDirectory: () async => dir,
    );
    addTearDown(store.close);
  });

  tearDown(() {
    container.dispose();
  });

  test('refresh loads the account desktops with the phone token', () async {
    late http.Request seen;
    container = buildContainer(
      MockClient((request) async {
        seen = request;
        return desktopsResponse();
      }),
    );

    await container.read(desktopListControllerProvider.notifier).refresh();

    final state = container.read(desktopListControllerProvider);
    expect(state.loading, isFalse);
    expect(state.desktops.length, 2);
    expect(state.desktops.first.desktopName, 'MacBook Pro');
    expect(state.desktops.last.online, isFalse);
    expect(state.selectedDesktopId, isNull);
    expect(seen.headers['Authorization'], 'Bearer dev_phone1.tok_1');
  });

  test('refresh maps network failures to a retryable error', () async {
    container = buildContainer(
      MockClient((_) async => throw http.ClientException('down')),
    );

    await container.read(desktopListControllerProvider.notifier).refresh();

    final state = container.read(desktopListControllerProvider);
    expect(state.error, 'NETWORK');
    expect(DesktopListController.messageFor('NETWORK'), contains('无法连接云端'));
  });

  test('select persists the desktop without changing identity', () async {
    container = buildContainer(MockClient((_) async => desktopsResponse()));

    await container.read(desktopListControllerProvider.notifier).select('dev_a');

    final stored = await CredentialStore(vault).read();
    expect(stored?.desktopId, 'dev_a');
    expect(stored?.deviceId, 'dev_phone1');
    expect(stored?.deviceToken, 'tok_1');
    expect(stored?.mode, ConnectionMode.cloud);
    expect(
      container.read(desktopListControllerProvider).selectedDesktopId,
      'dev_a',
    );
  });

  test('logout revokes the phone and clears keychain and scoped data', () async {
    await store.saveDraft('s1', 'draft');
    String? deleted;
    container = buildContainer(
      MockClient((request) async {
        if (request.method == 'DELETE') {
          deleted = request.url.toString();
          return http.Response('', 204);
        }
        return desktopsResponse();
      }),
    );

    await container.read(desktopListControllerProvider.notifier).logout();

    expect(deleted, 'https://relay.example.com/v1/devices/dev_phone1');
    expect(await CredentialStore(vault).read(), isNull);
    expect(await store.readDraft('s1'), isNull);
    final state = container.read(desktopListControllerProvider);
    expect(state.desktops, isEmpty);
    expect(state.selectedDesktopId, isNull);
  });
}
