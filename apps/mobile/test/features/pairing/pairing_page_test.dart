import 'dart:convert';

import 'package:claude_remote/data/credential_store.dart';
import 'package:claude_remote/data/pairing_api.dart';
import 'package:claude_remote/features/pairing/pairing_controller.dart';
import 'package:claude_remote/features/pairing/pairing_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'pairing_controller_test.dart'
    show InMemoryVault, pairingFailure, pairingSuccess, validQr;

Widget appUnderTest({
  required http.Client client,
  required InMemoryVault vault,
  required ValueChanged<String> Function(void Function(String) emit) capture,
}) {
  return ProviderScope(
    overrides: [
      credentialStoreProvider.overrideWithValue(CredentialStore(vault)),
      pairingApiProvider.overrideWithValue(PairingApi(client: client)),
    ],
    child: MaterialApp(
      home: PairingPage(
        scannerBuilder: (context, onCode) {
          capture(onCode);
          return const SizedBox.shrink();
        },
      ),
    ),
  );
}

void main() {
  late InMemoryVault vault;

  setUp(() {
    vault = InMemoryVault();
  });

  testWidgets('pairs from a scanned payload and leaves the page paired', (
    tester,
  ) async {
    late ValueChanged<String> emit;
    await tester.pumpWidget(
      appUnderTest(
        client: MockClient((_) async => pairingSuccess()),
        vault: vault,
        capture: (onCode) => emit = onCode,
      ),
    );

    emit(validQr());
    await tester.pumpAndSettle();

    expect(find.textContaining('配对成功'), findsOneWidget);
    expect(vault.values, isNotEmpty);
  });

  testWidgets('pairs by pasting the payload from the Mac terminal', (
    tester,
  ) async {
    await tester.pumpWidget(
      appUnderTest(
        client: MockClient((_) async => pairingSuccess()),
        vault: vault,
        capture: (_) => (_) {},
      ),
    );

    await tester.tap(find.byKey(const Key('pairingManualEntry')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('pairingPayloadField')),
      validQr(),
    );
    await tester.tap(find.byKey(const Key('pairingManualSubmit')));
    await tester.pumpAndSettle();

    expect(find.textContaining('配对成功'), findsOneWidget);
    expect(vault.values, isNotEmpty);
  });

  testWidgets('shows a retry affordance after a failed pairing', (
    tester,
  ) async {
    late ValueChanged<String> emit;
    await tester.pumpWidget(
      appUnderTest(
        client: MockClient(
          (_) async => pairingFailure('PAIRING_FAILED', 403),
        ),
        vault: vault,
        capture: (onCode) => emit = onCode,
      ),
    );

    emit(validQr());
    await tester.pumpAndSettle();

    expect(find.textContaining('失败'), findsOneWidget);
    expect(find.text('重新扫描'), findsOneWidget);
  });

  testWidgets('never renders the device token', (tester) async {
    late ValueChanged<String> emit;
    await tester.pumpWidget(
      appUnderTest(
        client: MockClient((_) async => pairingSuccess()),
        vault: vault,
        capture: (onCode) => emit = onCode,
      ),
    );

    emit(validQr());
    await tester.pumpAndSettle();

    expect(find.textContaining('token_DO_NOT_LEAK_99'), findsNothing);
    expect(jsonEncode(vault.values), contains('token_DO_NOT_LEAK_99'));
  });

  testWidgets('offers a cloud login entry next to the scanner', (tester) async {
    await tester.pumpWidget(
      appUnderTest(
        client: MockClient((_) async => pairingSuccess()),
        vault: vault,
        capture: (onCode) => (value) {},
      ),
    );

    expect(find.byKey(const Key('cloudLoginEntry')), findsOneWidget);
    expect(find.text('使用云端账号登录'), findsOneWidget);
  });
}