import 'dart:async';

import 'package:claude_remote/features/approvals/approval_content_api.dart';
import 'package:claude_remote/features/approvals/approval_detail_page.dart';
import 'package:claude_remote/protocol/s03_messages.dart';
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
  await tester.pumpAndSettle();
}

bool allowEnabled(WidgetTester tester) {
  return tester
          .widget<FilledButton>(find.byKey(const Key('allowButton')))
          .onPressed !=
      null;
}

bool denyEnabled(WidgetTester tester) {
  return tester
          .widget<OutlinedButton>(find.byKey(const Key('denyButton')))
          .onPressed !=
      null;
}

void main() {
  testWidgets('Bash shows the full command only after verified load', (
    tester,
  ) async {
    final harness = uiHarness(
      toolName: 'Bash',
      input: <String, Object?>{
        'command': 'echo S03_UI_OK',
        'description': 'fixture',
        'timeout': 5000,
      },
    );

    await pumpDetail(tester, harness);

    expect(
      tester.widget<SelectableText>(find.byKey(const Key('bashCommand'))).data,
      'echo S03_UI_OK',
    );
    expect(find.text('/fixture/项目'), findsOneWidget);
    expect(find.byKey(const Key('approvalHashVerified')), findsOneWidget);
    expect(allowEnabled(tester), isTrue);
    expect(denyEnabled(tester), isTrue);
  });

  testWidgets('allow stays disabled until content finishes loading', (
    tester,
  ) async {
    final gate = Completer<ApprovalTransportResponse>();
    final harness = uiHarness(
      toolName: 'Bash',
      input: <String, Object?>{'command': 'echo waiting'},
      onRequest: (index) => gate.future,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: ApprovalDetailPage(
          controller: harness.controller,
          summary: harness.summary,
        ),
      ),
    );
    await tester.pump();

    expect(allowEnabled(tester), isFalse);
    expect(denyEnabled(tester), isTrue);

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
    expect(allowEnabled(tester), isTrue);
  });

  testWidgets('Write and Edit render full fields and a non-diff notice', (
    tester,
  ) async {
    final write = uiHarness(
      toolName: 'Write',
      input: <String, Object?>{
        'file_path': '/fixture/项目/new.txt',
        'content': 'line one\nline two',
      },
    );
    await pumpDetail(tester, write);
    expect(find.text('/fixture/项目/new.txt'), findsOneWidget);
    expect(find.text('line one'), findsOneWidget);

    final edit = uiHarness(
      toolName: 'Edit',
      input: <String, Object?>{
        'file_path': '/fixture/项目/example.ts',
        'old_string': 'before',
        'new_string': 'after',
      },
    );
    await pumpDetail(tester, edit);
    expect(find.byKey(const Key('requestPreviewNotice')), findsOneWidget);
    expect(
      tester
          .widget<Text>(find.byKey(const Key('requestPreviewNotice')))
          .data,
      '由请求参数生成，不是实际文件 Diff 或执行结果',
    );
    expect(find.textContaining('- before'), findsOneWidget);
    expect(find.textContaining('+ after'), findsOneWidget);
  });

  testWidgets('other tools show the complete JSON without hiding fields', (
    tester,
  ) async {
    final harness = uiHarness(
      toolName: 'WebFetch',
      input: <String, Object?>{'url': 'https://example.com', 'prompt': 'x'},
    );

    await pumpDetail(tester, harness);

    expect(find.byKey(const Key('jsonApprovalInput')), findsOneWidget);
    final text = tester
        .widget<SelectableText>(find.byKey(const Key('jsonApprovalInput')))
        .data;
    expect(text, contains('https://example.com'));
  });

  testWidgets('hash failure disables allow but keeps deny available', (
    tester,
  ) async {
    final json = uiContent(
      toolName: 'Bash',
      input: <String, Object?>{'command': 'echo tampered'},
    );
    final harness = uiHarness(
      toolName: 'Bash',
      input: <String, Object?>{'command': 'echo tampered'},
      jsonText: json,
    );
    harness.transport.onRequest = (index) async => chunkResponse(
      approvalId: harness.summary.approvalId,
      chunkIndex: 0,
      chunkCount: 1,
      byteLength: harness.summary.content.byteLength,
      sha256: harness.summary.content.sha256,
      text: '$json ',
    );

    await pumpDetail(tester, harness);

    expect(find.byKey(const Key('approvalContentError')), findsOneWidget);
    expect(allowEnabled(tester), isFalse);
    expect(denyEnabled(tester), isTrue);
  });

  testWidgets('resolved approvals disable both buttons', (tester) async {
    final harness = uiHarness(
      toolName: 'Bash',
      input: <String, Object?>{'command': 'echo done'},
    );
    await pumpDetail(tester, harness);

    harness.controller.onResolved(resolutionFor(harness.summary));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('approvalResolved')), findsOneWidget);
    expect(allowEnabled(tester), isFalse);
    expect(denyEnabled(tester), isFalse);
  });

  testWidgets('defaultToNo requires an explicit confirmation first', (
    tester,
  ) async {
    final harness = uiHarness(
      toolName: 'Bash',
      input: <String, Object?>{'command': 'echo dangerous'},
      defaultToNo: true,
    );
    await pumpDetail(tester, harness);
    expect(find.byKey(const Key('defaultToNoWarning')), findsOneWidget);

    await tester.tap(find.byKey(const Key('allowButton')));
    await tester.pumpAndSettle();

    expect(find.text('确认允许一次？'), findsOneWidget);
    expect(harness.executor.requests, isEmpty);

    await tester.tap(find.byKey(const Key('confirmDefaultToNo')));
    await tester.pumpAndSettle();

    expect(harness.executor.requests, hasLength(1));
  });

  testWidgets('background masks the page and removes content', (tester) async {
    final harness = uiHarness(
      toolName: 'Bash',
      input: <String, Object?>{'command': 'echo secret'},
    );
    await pumpDetail(tester, harness);
    expect(find.text('echo secret'), findsOneWidget);

    harness.controller.onLifecycle(AppLifecycleState.paused);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('approvalPrivacyMask')), findsOneWidget);
    expect(find.text('echo secret'), findsNothing);
    expect(allowEnabled(tester), isFalse);
  });
}