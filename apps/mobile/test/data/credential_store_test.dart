import 'dart:convert';

import 'package:claude_remote/data/credential_store.dart';
import 'package:claude_remote/data/device_credential.dart';
import 'package:flutter_test/flutter_test.dart';

final class MapVault implements KeyValueVault {
  final Map<String, String> values = {};
  int deletes = 0;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    deletes += 1;
    values.remove(key);
  }
}

const credential = DeviceCredential(
  deviceId: 'device_01',
  deviceToken: 'token_DO_NOT_LEAK_99',
  baseUrl: 'https://mac.tailnet-abc.ts.net',
  desktopId: 'desktop_01',
);

void main() {
  late MapVault vault;
  late CredentialStore store;

  setUp(() {
    vault = MapVault();
    store = CredentialStore(vault);
  });

  test('round-trips a credential through the vault', () async {
    await store.save(credential);

    final restored = await store.read();

    expect(restored?.deviceId, 'device_01');
    expect(restored?.deviceToken, 'token_DO_NOT_LEAK_99');
    expect(restored?.baseUrl, 'https://mac.tailnet-abc.ts.net');
    expect(restored?.desktopId, 'desktop_01');
  });

  test('returns null when nothing is stored', () async {
    expect(await store.read(), isNull);
  });

  test('returns null for a corrupted entry', () async {
    vault.values[CredentialStore.credentialKey] = '{not json';
    expect(await store.read(), isNull);

    vault.values[CredentialStore.credentialKey] = jsonEncode({'deviceId': 1});
    expect(await store.read(), isNull);
  });

  test('clear deletes the stored key', () async {
    await store.save(credential);
    await store.clear();

    expect(vault.values, isEmpty);
    expect(vault.deletes, 1);
  });

  test('never prints the device token', () {
    expect(credential.toString(), isNot(contains('token_DO_NOT_LEAK_99')));
    expect(credential.toString(), contains('device_01'));
  });
}