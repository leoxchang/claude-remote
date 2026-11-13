import 'dart:convert';

import 'package:flutter/material.dart';

/// 其他支持工具的完整 JSON；不隐藏字段。
class JsonApprovalView extends StatelessWidget {
  const JsonApprovalView({super.key, required this.input});

  final Map<String, Object?> input;

  @override
  Widget build(BuildContext context) {
    return SelectableText(
      const JsonEncoder.withIndent('  ').convert(input),
      key: const Key('jsonApprovalInput'),
      style: const TextStyle(fontFamily: 'monospace'),
    );
  }
}