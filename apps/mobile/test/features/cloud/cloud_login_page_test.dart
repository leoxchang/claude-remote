import 'dart:convert';

import 'package:claude_remote/data/cloud_api.dart';
import 'package:claude_remote/data/credential_store.dart';
import 'package:claude_remote/features/cloud/cloud_login_controller.dart';
import 'package:claude_remote/features/cloud/cloud_login_page.dart';
import 'package:claude_remote/features/pairing/pairing_controller.dart'
    show credentialStoreProvider;
import 'package:flutter/material.dart';
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

Future<void> pumpLoginPage(
  WidgetTester tester, {
  required http.Response response,
  MemoryVault? vault,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        credentialStoreProvider.overrideWithValue(
          CredentialStore(vault ?? MemoryVault()),
        ),
        cloudPlatformProvider.overrideWithValue('ios'),
        cloudApiProvider.overrideWithValue(
          CloudApi(client: MockClient((_) async => response)),
        ),
      ],
      child: MaterialApp(
        initialRoute: CloudLoginPage.routeName,
        routes: {
          CloudLoginPage.routeName: (_) =>
              const CloudLoginPage(nextRoute: '/done'),
          '/done': (_) => const Scaffold(body: Text('done')),
        },
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('a successful login navigates to the next route', (tester) async {
    await pumpLoginPage(tester, response: loginSuccess());

    await tester.enterText(
      find.byKey(const Key('cloudRelayUrlField')),
      'relay.example.com',
    );
    await tester.enterText(
      find.byKey(const Key('cloudUsernameField')),
      'alice',
    );
    await tester.enterText(
      find.byKey(const Key('cloudPasswordField')),
      'secret',
    );
    await tester.tap(find.byKey(const Key('cloudLoginButton')));
    await tester.pumpAndSettle();

    expect(find.text('done'), findsOneWidget);
  });

  testWidgets('a rejected login shows a safe message and stays put', (
    tester,
  ) async {
    await pumpLoginPage(
      tester,
      response: http.Response(
        '{"error":{"code":"INVALID_CREDENTIALS","message":"x"}}',
        401,
      ),
    );

    await tester.enterText(
      find.byKey(const Key('cloudRelayUrlField')),
      'relay.example.com',
    );
    await tester.enterText(
      find.byKey(const Key('cloudUsernameField')),
      'alice',
    );
    await tester.enterText(
      find.byKey(const Key('cloudPasswordField')),
      'bad',
    );
    await tester.tap(find.byKey(const Key('cloudLoginButton')));
    await tester.pumpAndSettle();

    expect(find.text('done'), findsNothing);
    expect(find.byKey(const Key('cloudLoginError')), findsOneWidget);
    expect(find.text('账号或口令不正确'), findsOneWidget);
  });

  testWidgets('the relay url field starts with an https hint', (tester) async {
    await pumpLoginPage(tester, response: loginSuccess());

    expect(find.text('https://'), findsOneWidget);
  });
}
