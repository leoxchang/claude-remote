import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../data/providers.dart' show credentialProvider;
import '../cloud/cloud_login_page.dart';
import '../workspaces/workspace_page.dart';
import 'pairing_controller.dart';

/// 注入式扫码器；单元/Widget 测试用它替代真实相机。
typedef PairingScannerBuilder =
    Widget Function(BuildContext context, ValueChanged<String> onCode);

/// 配对页：扫码、状态和错误重试；不含任何路径或 token 输入框。
class PairingPage extends ConsumerWidget {
  const PairingPage({
    super.key,
    this.scannerBuilder,
    this.pairedRoute = WorkspacePage.routeName,
  });

  static const String routeName = '/pairing';

  final PairingScannerBuilder? scannerBuilder;
  final String pairedRoute;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(pairingControllerProvider);
    final controller = ref.read(pairingControllerProvider.notifier);
    return Scaffold(
      appBar: AppBar(title: const Text('配对 Mac')),
      body: switch (state.status) {
        PairingStatus.paired => _PairedView(
          onContinue: () {
            ref.invalidate(credentialProvider);
            Navigator.of(context).pushReplacementNamed(pairedRoute);
          },
        ),
        PairingStatus.failed => _FailedView(
          message: state.message ?? '配对失败，请重试',
          onRetry: controller.startScan,
        ),
        _ => _ScanView(
          builder: scannerBuilder ?? _defaultScanner,
          onCode: controller.submit,
          onManual: () => _openManualEntry(context, controller),
        ),
      },
    );
  }

  /// 模拟器/相机不可用时，粘贴 Mac 终端输出的配对载荷。
  Future<void> _openManualEntry(
    BuildContext context,
    PairingController controller,
  ) async {
    final payload = await showDialog<String>(
      context: context,
      builder: (_) => const _ManualPayloadDialog(),
    );
    if (payload == null || payload.isEmpty) return;
    controller.submit(payload);
  }

  Widget _defaultScanner(BuildContext context, ValueChanged<String> onCode) {
    return MobileScanner(
      onDetect: (capture) {
        for (final barcode in capture.barcodes) {
          final raw = barcode.rawValue;
          if (raw != null && raw.isNotEmpty) {
            onCode(raw);
            return;
          }
        }
      },
    );
  }
}

class _ScanView extends StatelessWidget {
  const _ScanView({
    required this.builder,
    required this.onCode,
    required this.onManual,
  });

  final PairingScannerBuilder builder;
  final ValueChanged<String> onCode;
  final VoidCallback onManual;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Padding(
          padding: EdgeInsets.all(16),
          child: Text('在 Mac 上运行 pair 命令，然后扫描终端里的二维码'),
        ),
        Expanded(child: builder(context, onCode)),
        Padding(
          padding: const EdgeInsets.all(8),
          child: TextButton(
            key: const Key('pairingManualEntry'),
            onPressed: onManual,
            child: const Text('无法扫码？手动输入配对信息'),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(bottom: 16),
          child: TextButton(
            key: const Key('cloudLoginEntry'),
            onPressed: () =>
                Navigator.of(context).pushNamed(CloudLoginPage.routeName),
            child: const Text('使用云端账号登录'),
          ),
        ),
      ],
    );
  }
}

/// 手动粘贴一次性配对载荷；内容只在本页内存中。
class _ManualPayloadDialog extends StatefulWidget {
  const _ManualPayloadDialog();

  @override
  State<_ManualPayloadDialog> createState() => _ManualPayloadDialogState();
}

class _ManualPayloadDialogState extends State<_ManualPayloadDialog> {
  final TextEditingController _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('手动配对'),
      content: TextField(
        key: const Key('pairingPayloadField'),
        controller: _controller,
        autofocus: true,
        minLines: 3,
        maxLines: 6,
        decoration: const InputDecoration(
          hintText: '粘贴 Mac 上 pair 命令输出的 payload',
          border: OutlineInputBorder(),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          key: const Key('pairingManualSubmit'),
          onPressed: () =>
              Navigator.of(context).pop(_controller.text.trim()),
          child: const Text('配对'),
        ),
      ],
    );
  }
}

class _FailedView extends StatelessWidget {
  const _FailedView({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: 16),
          FilledButton(onPressed: onRetry, child: const Text('重新扫描')),
        ],
      ),
    );
  }
}

class _PairedView extends StatelessWidget {
  const _PairedView({required this.onContinue});

  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('配对成功'),
          const SizedBox(height: 16),
          FilledButton(onPressed: onContinue, child: const Text('进入聊天')),
        ],
      ),
    );
  }
}