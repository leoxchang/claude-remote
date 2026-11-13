import 'dart:async';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/features/approvals/approval_command_coordinator.dart';
import 'package:claude_remote/features/approvals/approval_content_api.dart';
import 'package:claude_remote/features/approvals/approval_content_loader.dart';
import 'package:claude_remote/features/approvals/approval_controller.dart';
import 'package:claude_remote/protocol/s03_messages.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_test/flutter_test.dart';

import 'approval_test_support.dart';

abstract interface class ControllerHarness {
  ApprovalController get controller;
  FakeTransport get transport;
  FakeExecutor get executor;
  ApprovalSummary get summary;
}

ControllerHarness harness({bool Function()? isOnline}) {
  final json = approvalJson();
  final summary = summaryFor(json);
  final transport = FakeTransport(
    chunks: <int, ApprovalTransportResponse>{
      0: chunkResponse(
        approvalId: summary.approvalId,
        chunkIndex: 0,
        chunkCount: 1,
        byteLength: summary.content.byteLength,
        sha256: summary.content.sha256,
        text: json,
      ),
    },
  );
  final executor = FakeExecutor()
    ..outcomes.add(<String, Object?>{
      'approvalId': 'approval_01',
      'status': 'approved_once',
      'resolvedAt': 1762432860000,
    });
  final api = ApprovalContentApi(
    credentials: pairedCredentialStore(),
    transport: transport,
  );
  late final ApprovalController controller;
  final coordinator = ApprovalCommandCoordinator(
    client: executor,
    isOnline: isOnline ?? () => true,
    verifiedSha: (approvalId) =>
        controller.approvalContentCache[approvalId]?.sha256,
  );
  controller = ApprovalController(
    loader: ApprovalContentLoader(api),
    coordinator: coordinator,
    isOnline: isOnline ?? () => true,
  );
  return _Harness(
    controller: controller,
    transport: transport,
    executor: executor,
    summary: summary,
  );
}

final class _Harness implements ControllerHarness {
  _Harness({
    required this.controller,
    required this.transport,
    required this.executor,
    required this.summary,
  });

  @override
  final ApprovalController controller;
  @override
  final FakeTransport transport;
  @override
  final FakeExecutor executor;
  @override
  final ApprovalSummary summary;
}

bool _hasVerifiedSha(ApprovalController controller, ApprovalSummary summary) {
  return controller.approvalContentCache[summary.approvalId] != null;
}

void main() {
  test('canAllow needs verified content, online state and no mask', () async {
    final env = harness();
    final controller = env.controller;

    expect(controller.canAllow(env.summary), isFalse);
    expect(controller.canDeny(env.summary), isTrue);

    await controller.loadContent(env.summary);
    _hasVerifiedSha(controller, env.summary);

    expect(controller.stateOf(env.summary.approvalId), ApprovalActionState.ready);
    expect(controller.canDeny(env.summary), isTrue);

    controller.onLifecycle(AppLifecycleState.paused);
    expect(controller.masked, isTrue);
    expect(controller.canAllow(env.summary), isFalse);
    expect(controller.canDeny(env.summary), isFalse);
    expect(controller.approvalContentCache, isEmpty);
  });

  test('late content cannot repopulate the cache after background', () async {
    final env = harness();
    final controller = env.controller;
    final gate = Completer<ApprovalTransportResponse>();
    env.transport.onRequest = (index) => gate.future;

    final pendingLoad = controller.loadContent(env.summary);
    controller.onLifecycle(AppLifecycleState.paused);
    gate.complete(
      chunkResponse(
        approvalId: env.summary.approvalId,
        chunkIndex: 0,
        chunkCount: 1,
        byteLength: env.summary.content.byteLength,
        sha256: env.summary.content.sha256,
        text: approvalJson(),
      ),
    );
    await pendingLoad;

    expect(
      controller.approvalContentCache[env.summary.approvalId],
      isNull,
    );
    expect(controller.canAllow(env.summary), isFalse);
  });

  test('late content cannot repopulate after resolution', () async {
    final env = harness();
    final controller = env.controller;
    final gate = Completer<ApprovalTransportResponse>();
    env.transport.onRequest = (index) => gate.future;

    final pendingLoad = controller.loadContent(env.summary);
    controller.onResolved(
      PermissionResolution(
        approvalId: env.summary.approvalId,
        sessionId: env.summary.sessionId,
        runId: env.summary.runId,
        status: ApprovalStatus.denied,
        resolvedAt: 1762432860000,
        reason: ResolutionReason.userDeny,
      ),
    );
    gate.complete(
      chunkResponse(
        approvalId: env.summary.approvalId,
        chunkIndex: 0,
        chunkCount: 1,
        byteLength: env.summary.content.byteLength,
        sha256: env.summary.content.sha256,
        text: approvalJson(),
      ),
    );
    await pendingLoad;

    expect(controller.approvalContentCache[env.summary.approvalId], isNull);
    expect(
      controller.stateOf(env.summary.approvalId),
      ApprovalActionState.resolved,
    );
    expect(controller.canAllow(env.summary), isFalse);
  });

  test('agent instance change clears content and marks old approvals unknown', () async {
    final env = harness();
    final controller = env.controller;
    await controller.loadContent(env.summary);
    _hasVerifiedSha(controller, env.summary);
    expect(controller.canAllow(env.summary), isTrue);

    controller.onAgentInstanceChanged();

    expect(controller.approvalContentCache, isEmpty);
    expect(
      controller.stateOf(env.summary.approvalId),
      ApprovalActionState.unknown,
    );
    expect(controller.canAllow(env.summary), isFalse);
  });

  test('resume reloads only the still-pending summaries', () async {
    final env = harness();
    final controller = env.controller;
    controller.onLifecycle(AppLifecycleState.paused);

    await controller.onResume(<ApprovalSummary>[env.summary]);

    expect(controller.masked, isFalse);
    expect(
      controller.approvalContentCache[env.summary.approvalId],
      isNotNull,
    );
    expect(controller.stateOf(env.summary.approvalId), ApprovalActionState.ready);
  });

  test('allow marks the approval resolved and drops its content', () async {
    final env = harness();
    final controller = env.controller;
    await controller.loadContent(env.summary);
    _hasVerifiedSha(controller, env.summary);

    final result = await controller.allowOnce(env.summary);

    expect(result.status, ApprovalStatus.approvedOnce);
    expect(controller.approvalContentCache, isEmpty);
    expect(
      controller.stateOf(env.summary.approvalId),
      ApprovalActionState.resolved,
    );
    expect(env.executor.requests, hasLength(1));
  });

  test('deny works while content is still loading, allow does not', () async {
    final env = harness();
    final controller = env.controller;
    env.executor.outcomes
      ..clear()
      ..add(<String, Object?>{
        'approvalId': 'approval_01',
        'status': 'denied',
        'resolvedAt': 1762432860000,
      });

    expect(controller.canAllow(env.summary), isFalse);
    final result = await controller.deny(env.summary);

    expect(result.status, ApprovalStatus.denied);
    expect(controller.stateOf(env.summary.approvalId), ApprovalActionState.resolved);
  });

  test('offline controller refuses both actions', () async {
    final env = harness(isOnline: () => false);
    final controller = env.controller;

    await expectLater(
      controller.deny(env.summary),
      throwsA(
        isA<CommandFailure>().having(
          (error) => error.code,
          'code',
          'APPROVAL_NOT_READY',
        ),
      ),
    );
    expect(env.executor.requests, isEmpty);
  });
}