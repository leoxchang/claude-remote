import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../data/providers.dart' show credentialProvider;
import 'pairing_controller.dart';

/// 注入式扫码器；单元/Widget 测试用它替代真实相机。
typedef PairingScannerBuilder =
    Widget Function(BuildContext context, ValueChanged<String> onCode);

/// 配对页：扫码、状态和错误重试；不含任何路径或 token 输入框。
class PairingPage extends ConsumerWidget {
  const PairingPage({
    super.key,
    this.scannerBuilder,
    this.pairedRoute = '/chat',
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
        ),
      },
    );
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
  const _ScanView({required this.builder, required this.onCode});

  final PairingScannerBuilder builder;
  final ValueChanged<String> onCode;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Padding(
          padding: EdgeInsets.all(16),
          child: Text('在 Mac 上运行 pair 命令，然后扫描终端里的二维码'),
        ),
        Expanded(child: builder(context, onCode)),
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