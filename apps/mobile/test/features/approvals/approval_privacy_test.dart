import 'dart:async';

import 'package:claude_remote/features/approvals/approval_content_api.dart';
import 'package:claude_remote/features/approvals/approval_detail_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'approval_ui_support.dart';

Future<void> pumpDetail(WidgetTester tester, UiHarness harness) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ApprovalDetailPage(
        controller: harness.controller,
        summary: harness.summary,
      ),
    ),
  );
}

bool allowEnabled(WidgetTester tester) {
  return tester
          .widget<FilledButton>(find.byKey(const Key('allowButton')))
          .onPressed !=
      null;
}

void main() {
  testWidgets('late loader result cannot enable allow after background', (
    tester,
  ) async {
    final gate = Completer<ApprovalTransportResponse>();
    final harness = uiHarness(
      toolName: 'Bash',
      input: <String, Object?>{'command': 'echo late'},
      onRequest: (index) => gate.future,
    );
    await pumpDetail(tester, harness);
    await tester.pump();

    harness.controller.onLifecycle(AppLifecycleState.inactive);
    await tester.pump();
    gate.complete(
      chunkResponse(
        approvalId: harness.summary.approvalId,
        chunkIndex: 0,
        chunkCount: 1,
        byteLength: harness.summary.content.byteLength,
        sha256: harness.summary.content.sha256,
        text: harness.jsonText,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('approvalPrivacyMask')), findsOneWidget);
    expect(find.text('echo late'), findsNothing);
    expect(allowEnabled(tester), isFalse);
  });

  testWidgets('late loader result cannot enable allow after resolution', (
    tester,
  ) async {
    final gate = Completer<ApprovalTransportResponse>();
    final harness = uiHarness(
      toolName: 'Bash',
      input: <String, Object?>{'command': 'echo resolved'},
      onRequest: (index) => gate.future,
    );
    await pumpDetail(tester, harness);
    await tester.pump();

    harness.controller.onResolved(resolutionFor(harness.summary));
    gate.complete(
      chunkResponse(
        approvalId: harness.summary.approvalId,
        chunkIndex: 0,
        chunkCount: 1,
        byteLength: harness.summary.content.byteLength,
        sha256: harness.summary.content.sha256,
        text: harness.jsonText,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('approvalResolved')), findsOneWidget);
    expect(find.text('echo resolved'), findsNothing);
    expect(allowEnabled(tester), isFalse);
  });

  testWidgets('agent restart shows the unknown result warning', (tester) async {
    final harness = uiHarness(
      toolName: 'Bash',
      input: <String, Object?>{'command': 'echo restart'},
    );
    await pumpDetail(tester, harness);
    await tester.pumpAndSettle();

    harness.controller.onAgentInstanceChanged();
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('approvalUnknown')), findsOneWidget);
    expect(find.text('echo restart'), findsNothing);
    expect(allowEnabled(tester), isFalse);
  });
}