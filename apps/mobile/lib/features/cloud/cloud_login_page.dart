import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'cloud_login_controller.dart';
import 'cloud_routes.dart';

/// 云端登录页：云端地址 + 用户名 + 口令；成功后进入电脑列表。
class CloudLoginPage extends ConsumerStatefulWidget {
  const CloudLoginPage({super.key, this.nextRoute = cloudDesktopListRoute});

  static const String routeName = '/cloud/login';

  final String nextRoute;

  @override
  ConsumerState<CloudLoginPage> createState() => _CloudLoginPageState();
}

class _CloudLoginPageState extends ConsumerState<CloudLoginPage> {
  static const String _initialRelayUrl = 'https://';

  final TextEditingController _relayUrl = TextEditingController(
    text: _initialRelayUrl,
  );
  final TextEditingController _username = TextEditingController();
  final TextEditingController _password = TextEditingController();

  @override
  void dispose() {
    _relayUrl.dispose();
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final credential = await ref
        .read(cloudLoginControllerProvider.notifier)
        .submit(
          relayUrl: _relayUrl.text,
          username: _username.text.trim(),
          password: _password.text,
        );
    if (!mounted || credential == null) return;
    Navigator.of(context).pushReplacementNamed(widget.nextRoute);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(cloudLoginControllerProvider);
    final submitting = state.status == CloudLoginStatus.submitting;
    final message = state.message;
    return Scaffold(
      appBar: AppBar(title: const Text('云端账号登录')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            key: const Key('cloudRelayUrlField'),
            controller: _relayUrl,
            enabled: !submitting,
            keyboardType: TextInputType.url,
            autocorrect: false,
            decoration: const InputDecoration(
              labelText: '云端地址',
              hintText: '例如 relay.example.com',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('cloudUsernameField'),
            controller: _username,
            enabled: !submitting,
            autocorrect: false,
            decoration: const InputDecoration(labelText: '用户名'),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('cloudPasswordField'),
            controller: _password,
            enabled: !submitting,
            obscureText: true,
            autocorrect: false,
            decoration: const InputDecoration(labelText: '口令'),
          ),
          const SizedBox(height: 24),
          FilledButton(
            key: const Key('cloudLoginButton'),
            onPressed: submitting ? null : _submit,
            child: submitting
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(),
                  )
                : const Text('登录'),
          ),
          if (message != null)
            Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Text(
                message,
                key: const Key('cloudLoginError'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          const SizedBox(height: 12),
          Text(
            '登录后会列出账号下的电脑；可随时在电脑列表页退出云端账号。',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}
