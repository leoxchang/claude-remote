import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'data/providers.dart';
import 'features/chat/chat_page.dart';
import 'features/pairing/pairing_page.dart';

void main() {
  runApp(const ProviderScope(child: ClaudeRemoteApp()));
}

/// S01 两页应用：有凭证进聊天页，否则进配对页。
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
        ChatPage.routeName: (_) => const ChatPage(),
      },
    );
  }
}

/// 启动分流：读取 Keychain 后决定首屏。
class StartPage extends ConsumerWidget {
  const StartPage({super.key});

  static const String routeName = '/';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final credential = ref.watch(credentialProvider);
    return credential.when(
      loading: () =>
          const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (_, _) => const PairingPage(),
      data: (value) => value == null ? const PairingPage() : const ChatPage(),
    );
  }
}