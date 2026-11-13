import 'package:claude_remote/features/chat/widgets/pending_approval_card.dart';
import 'package:claude_remote/protocol/s03_messages.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../approvals/approval_test_support.dart';

ApprovalSummary cardSummary({String? agentId}) {
  return ApprovalSummary(
    approvalId: 'approval_01',
    workspaceId: 'ws_01',
    sessionId: 'session_01',
    runId: 'run_01',
    toolUseId: 'toolu_01',
    toolName: 'Bash',
    createdAt: 1762432800000,
    expiresAt: 1762432920000,
    defaultToNo: false,
    content: const ApprovalContentDescriptor(
      encoding: 'json-utf8',
      byteLength: 100,
      sha256: 'hash',
      chunkCount: 1,
    ),
    agentId: agentId,
  );
}

void main() {
  testWidgets('card shows only the safe summary and opens on tap', (
    tester,
  ) async {
    var tapped = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PendingApprovalCard(
            approval: cardSummary(),
            onTap: () => tapped += 1,
          ),
        ),
      ),
    );

    expect(find.text('Bash 等待审批'), findsOneWidget);
    expect(find.text('点击查看完整请求'), findsOneWidget);
    expect(find.textContaining('command'), findsNothing);
    expect(find.textContaining('/fixture'), findsNothing);

    await tester.tap(find.byType(ListTile));
    expect(tapped, 1);
  });

  testWidgets('card marks sub-agent approvals', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PendingApprovalCard(
            approval: cardSummary(agentId: 'agent_02'),
            onTap: () {},
          ),
        ),
      ),
    );

    expect(find.text('子代理 agent_02 · 点击查看'), findsOneWidget);
  });
}