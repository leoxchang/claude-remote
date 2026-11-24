import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'data/device_credential.dart';
import 'data/providers.dart';
import 'features/chat/chat_page.dart';
import 'features/cloud/cloud_login_page.dart';
import 'features/cloud/desktop_list_page.dart';
import 'features/pairing/pairing_page.dart';
import 'features/workspaces/workspace_page.dart';

void main() {
  runApp(const ProviderScope(child: ClaudeRemoteApp()));
}

/// 有凭证进项目列表，否则进配对页；聊天页由会话列表进入。
class ClaudeRemoteApp extends StatelessWidget {
  const ClaudeRemoteApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Claude Remote',
      initialRoute: StartPage.routeName,
      routes: {
        StartPage.routeName: (_) => const StartPage(),
        PairingPage.routeName: (_) => const PairingPage(),
        CloudLoginPage.routeName: (_) => const CloudLoginPage(),
        DesktopListPage.routeName: (_) => const DesktopListPage(),
        WorkspacePage.routeName: (_) => const WorkspacePage(),
        ChatPage.routeName: (_) => const ChatPage(),
      },
    );
  }
}

/// 启动分流：读取 Keychain 后决定首屏。
class StartPage extends ConsumerWidget {
  const StartPage({super.key});

  static const String routeName = '/';

  /// 无凭证 → 配对页；云端未选电脑 → 电脑列表；其余 → 项目列表。
  static String destinationFor(DeviceCredential? credential) {
    if (credential == null) return PairingPage.routeName;
    if (credential.mode == ConnectionMode.cloud &&
        credential.desktopId == null) {
      return DesktopListPage.routeName;
    }
    return WorkspacePage.routeName;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final credential = ref.watch(credentialProvider);
    return credential.when(
      loading: () =>
          const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (_, _) => const PairingPage(),
      data: (value) => switch (StartPage.destinationFor(value)) {
        DesktopListPage.routeName => const DesktopListPage(),
        PairingPage.routeName => const PairingPage(),
        _ => const WorkspacePage(),
      },
    );
  }
}