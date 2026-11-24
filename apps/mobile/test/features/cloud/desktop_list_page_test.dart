import 'dart:convert';

import 'package:claude_remote/data/cloud_api.dart';
import 'package:claude_remote/data/credential_store.dart';
import 'package:claude_remote/data/device_credential.dart';
import 'package:claude_remote/data/recovery_providers.dart';
import 'package:claude_remote/features/cloud/cloud_login_controller.dart';
import 'package:claude_remote/features/cloud/desktop_list_page.dart';
import 'package:claude_remote/features/pairing/pairing_controller.dart'
    show credentialStoreProvider;
import 'package:claude_remote/features/pairing/pairing_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import '../approvals/approval_test_support.dart' show MemoryVault;

const DeviceCredential cloudCredential = DeviceCredential(
  deviceId: 'dev_phone1',
  deviceToken: 'tok_1',
  baseUrl: 'https://relay.example.com',
  mode: ConnectionMode.cloud,
);

http.Response desktopsResponse({bool empty = false}) {
  return http.Response(
    jsonEncode({
      'desktops': empty
          ? const <Object>[]
          : const [
              {
                'desktopId': 'dev_a',
                'desktopName': 'MacBook Pro',
                'platform': 'macos',
                'appVersion': '1.0.0',
                'online': true,
                'lastSeenAt': null,
              },
              {
                'desktopId': 'dev_b',
                'desktopName': 'Mac mini',
                'platform': 'macos',
                'appVersion': '1.0.0',
                'online': false,
                'lastSeenAt': 1763890000000,
              },
            ],
    }),
    200,
  );
}

void main() {
  late MemoryVault vault;

  setUp(() async {
    vault = MemoryVault();
    await CredentialStore(vault).save(cloudCredential);
  });

  Future<void> pumpPage(
    WidgetTester tester, {
    required http.Response response,
    String selectedDesktopId = 'dev_a',
  }) async {
    final credential = cloudCredential.withDesktop(selectedDesktopId);
    await CredentialStore(vault).save(credential);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          credentialStoreProvider.overrideWithValue(CredentialStore(vault)),
          cloudApiProvider.overrideWithValue(
            CloudApi(client: MockClient((request) async {
              if (request.method == 'DELETE') {
                return http.Response('', 204);
              }
              return response;
            })),
          ),
          // widget 测试不用真实 sqflite：本地库清理由控制器测试覆盖。
          recoveryStoreProvider.overrideWith(
            (ref) async => throw StateError('no local store'),
          ),
        ],
        child: MaterialApp(
          home: const DesktopListPage(workspaceRoute: '/workspaces-done'),
          routes: {
            '/workspaces-done': (_) =>
                const Scaffold(body: Text('workspaces-done')),
            PairingPage.routeName: (_) => const Scaffold(body: Text('pairing')),
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('lists desktops and marks the current one', (tester) async {
    await pumpPage(tester, response: desktopsResponse());

    expect(find.text('MacBook Pro'), findsOneWidget);
    expect(find.text('Mac mini'), findsOneWidget);
    expect(find.byIcon(Icons.check), findsOneWidget);
  });

  testWidgets('tapping a desktop switches and enters workspaces', (
    tester,
  ) async {
    await pumpPage(tester, response: desktopsResponse());

    await tester.tap(find.byKey(const Key('desktopListTile_dev_b')));
    await tester.pumpAndSettle();

    expect(find.text('workspaces-done'), findsOneWidget);
    final stored = await CredentialStore(vault).read();
    expect(stored?.desktopId, 'dev_b');
  });

  testWidgets('an empty account shows setup guidance', (tester) async {
    await pumpPage(tester, response: desktopsResponse(empty: true));

    expect(find.textContaining('relay login'), findsOneWidget);
  });

  testWidgets('logout confirms, clears the keychain and leaves cloud mode', (
    tester,
  ) async {
    await pumpPage(tester, response: desktopsResponse());

    await tester.tap(find.byKey(const Key('cloudLogoutButton')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('cloudLogoutConfirm')));
    await tester.pumpAndSettle();

    expect(await CredentialStore(vault).read(), isNull);
    expect(find.text('pairing'), findsOneWidget);
  });
}
