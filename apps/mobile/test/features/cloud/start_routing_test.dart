import 'package:claude_remote/data/device_credential.dart';
import 'package:claude_remote/features/cloud/desktop_list_page.dart';
import 'package:claude_remote/features/pairing/pairing_page.dart';
import 'package:claude_remote/features/workspaces/workspace_page.dart';
import 'package:claude_remote/main.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('no credential lands on the pairing page', () {
    expect(StartPage.destinationFor(null), PairingPage.routeName);
  });

  test('cloud credential without a desktop lands on the desktop list', () {
    expect(
      StartPage.destinationFor(
        const DeviceCredential(
          deviceId: 'd',
          deviceToken: 't',
          baseUrl: 'https://relay.example.com',
          mode: ConnectionMode.cloud,
        ),
      ),
      DesktopListPage.routeName,
    );
  });

  test('cloud credential with a desktop lands on workspaces', () {
    expect(
      StartPage.destinationFor(
        const DeviceCredential(
          deviceId: 'd',
          deviceToken: 't',
          baseUrl: 'https://relay.example.com',
          desktopId: 'dev_a',
          mode: ConnectionMode.cloud,
        ),
      ),
      WorkspacePage.routeName,
    );
  });

  test('direct credential lands on workspaces', () {
    expect(
      StartPage.destinationFor(
        const DeviceCredential(
          deviceId: 'd',
          deviceToken: 't',
          baseUrl: 'https://mac.example.ts.net',
        ),
      ),
      WorkspacePage.routeName,
    );
  });
}
