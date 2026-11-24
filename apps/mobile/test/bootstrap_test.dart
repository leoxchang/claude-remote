import 'dart:io';

import 'package:claude_remote/data/providers.dart';
import 'package:claude_remote/features/chat/chat_page.dart';
import 'package:claude_remote/features/cloud/cloud_login_page.dart';
import 'package:claude_remote/features/pairing/pairing_page.dart';
import 'package:claude_remote/features/workspaces/workspace_page.dart';
import 'package:claude_remote/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// 断言 S01 计划的固定依赖版本（精确版本，不用 ^）。
void expectPinnedDependency(String pubspec, String name, String version) {
  expect(
    pubspec.contains('  $name: $version'),
    isTrue,
    reason: '$name must be pinned to $version',
  );
}

void main() {
  late String pubspec;

  setUpAll(() {
    pubspec = File('pubspec.yaml').readAsStringSync();
  });

  test('pins the S01 Flutter dependencies', () {
    expectPinnedDependency(pubspec, 'flutter_riverpod', '3.5.0');
    expectPinnedDependency(pubspec, 'web_socket_channel', '3.0.3');
    expectPinnedDependency(pubspec, 'flutter_secure_storage', '11.2.0');
    expectPinnedDependency(pubspec, 'mobile_scanner', '7.5.0');
  });

  testWidgets('starts on the pairing route without a stored credential', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          credentialProvider.overrideWith((ref) async => null),
        ],
        child: const ClaudeRemoteApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('配对 Mac'), findsOneWidget);
    expect(find.text('Chat'), findsNothing);

    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.initialRoute, StartPage.routeName);
    expect(
      app.routes?.keys.toSet(),
      {
        StartPage.routeName,
        PairingPage.routeName,
        CloudLoginPage.routeName,
        WorkspacePage.routeName,
        ChatPage.routeName,
      },
    );
  });
}