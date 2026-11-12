import 'dart:convert';

import 'package:claude_remote/data/credential_store.dart';
import 'package:claude_remote/data/pairing_api.dart';
import 'package:claude_remote/features/pairing/pairing_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final class InMemoryVault implements KeyValueVault {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

String validQr() {
  return jsonEncode({
    'v': 1,
    'baseUrl': 'https://mac.tailnet-abc.ts.net',
    'pairingId': 'pair_01',
    'code': 'code_0123456789',
    'expiresAt': DateTime.now().millisecondsSinceEpoch + 60 * 1000,
  });
}

http.Response pairingSuccess() {
  return http.Response(
    jsonEncode({
      'deviceId': 'device_01',
      'deviceToken': 'token_DO_NOT_LEAK_99',
      'desktopId': 'desktop_01',
      'protocolVersion': 1,
      'workspace': {'workspaceId': 'default', 'displayName': 'Fixture'},
    }),
    201,
    headers: {'content-type': 'application/json'},
  );
}

http.Response pairingFailure(String code, int status) {
  return http.Response(
    jsonEncode({
      'error': {'code': code, 'message': code},
    }),
    status,
    headers: {'content-type': 'application/json'},
  );
}

void main() {
  late InMemoryVault vault;
  late List<Uri> requests;

  ProviderContainer containerWith(http.Client client) {
    requests = [];
    final container = ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(CredentialStore(vault)),
        pairingApiProvider.overrideWithValue(PairingApi(client: client)),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  http.Client recording(http.Response Function(int) responder) {
    return MockClient((request) async {
      requests.add(request.url);
      return responder(requests.length);
    });
  }

  setUp(() {
    vault = InMemoryVault();
  });

  test('stores the credential in the vault after a successful pair', () async {
    final container = containerWith(recording((_) => pairingSuccess()));
    final controller = container.read(pairingControllerProvider.notifier);

    await controller.submit(validQr());

    final state = container.read(pairingControllerProvider);
    expect(state.status, PairingStatus.paired);
    expect(state.credential?.deviceId, 'device_01');
    expect(vault.values.values.join(), contains('token_DO_NOT_LEAK_99'));
    expect(state.toString(), isNot(contains('token_DO_NOT_LEAK_99')));
  });

  test('surfaces a safe message for PAIRING_FAILED', () async {
    final container = containerWith(
      recording((_) => pairingFailure('PAIRING_FAILED', 403)),
    );
    final controller = container.read(pairingControllerProvider.notifier);

    await controller.submit(validQr());

    final state = container.read(pairingControllerProvider);
    expect(state.status, PairingStatus.failed);
    expect(state.message, isNotNull);
    expect(state.message, isNot(contains('token')));
  });

  test('stops after five failed attempts', () async {
    final container = containerWith(
      recording((_) => pairingFailure('PAIRING_FAILED', 403)),
    );
    final controller = container.read(pairingControllerProvider.notifier);

    for (var attempt = 0; attempt < 5; attempt += 1) {
      await controller.submit(validQr());
    }
    await controller.submit(validQr());

    expect(requests, hasLength(5));
    expect(container.read(pairingControllerProvider).status, PairingStatus.failed);
  });

  test('maps DEVICE_ALREADY_PAIRED to a distinct message', () async {
    final container = containerWith(
      recording((_) => pairingFailure('DEVICE_ALREADY_PAIRED', 409)),
    );
    final controller = container.read(pairingControllerProvider.notifier);

    await controller.submit(validQr());

    final state = container.read(pairingControllerProvider);
    expect(state.status, PairingStatus.failed);
    expect(state.message, contains('已配对'));
  });

  test('rejects an expired QR without calling the API', () async {
    final container = containerWith(recording((_) => pairingSuccess()));
    final controller = container.read(pairingControllerProvider.notifier);
    final expired = jsonEncode({
      'v': 1,
      'baseUrl': 'https://mac.tailnet-abc.ts.net',
      'pairingId': 'pair_01',
      'code': 'code_0123456789',
      'expiresAt': DateTime.now().millisecondsSinceEpoch - 1000,
    });

    await controller.submit(expired);

    expect(requests, isEmpty);
    expect(container.read(pairingControllerProvider).status, PairingStatus.failed);
  });

  test('clear removes the stored credential', () async {
    final container = containerWith(recording((_) => pairingSuccess()));
    final controller = container.read(pairingControllerProvider.notifier);
    await controller.submit(validQr());

    await controller.clearCredential();

    expect(vault.values, isEmpty);
    expect(container.read(pairingControllerProvider).status, PairingStatus.unpaired);
  });
}