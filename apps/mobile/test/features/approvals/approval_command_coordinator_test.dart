import 'dart:async';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/data/agent_socket.dart';
import 'package:claude_remote/features/approvals/approval_command_coordinator.dart';
import 'package:claude_remote/protocol/s03_messages.dart';
import 'package:flutter_test/flutter_test.dart';

import 'approval_test_support.dart';

JsonMap okData({String status = 'approved_once'}) => <String, Object?>{
  'approvalId': 'approval_01',
  'status': status,
  'resolvedAt': 1762432860000,
};

void main() {
  test('allow sends every captured id and the verified decision', () async {
    final json = approvalJson();
    final summary = summaryFor(json);
    final executor = FakeExecutor()..outcomes.add(okData());
    var online = true;
    final coordinator = ApprovalCommandCoordinator(
      client: executor,
      isOnline: () => online,
      verifiedSha: (approvalId) => summary.content.sha256,
    );

    final result = await coordinator.allowOnce(summary);

    expect(result.status, ApprovalStatus.approvedOnce);
    expect(executor.requests, hasLength(1));
    final request = executor.requests.single;
    expect(request.type, 'permission.respond');
    expect(request.approvalId, 'approval_01');
    expect(request.sessionId, 'session_01');
    expect(request.runId, 'run_01');
    expect(request.workspaceId, 'ws_01');
    expect(request.payload['decision'], 'allow_once');

    final message = request.toMessage(1);
    expect(message.approvalId, 'approval_01');

    online = false;
    expect(
      () => coordinator.deny(summary),
      throwsA(
        isA<CommandFailure>().having(
          (error) => error.code,
          'code',
          'NOT_CONNECTED',
        ),
      ),
    );
  });

  test('allow is blocked until the same sha is verified', () async {
    final json = approvalJson();
    final summary = summaryFor(json);
    final executor = FakeExecutor()..outcomes.add(okData());
    final coordinator = ApprovalCommandCoordinator(
      client: executor,
      isOnline: () => true,
      verifiedSha: (approvalId) => null,
    );

    expect(
      () => coordinator.allowOnce(summary),
      throwsA(
        isA<CommandFailure>().having(
          (error) => error.code,
          'code',
          'CONTENT_NOT_VERIFIED',
        ),
      ),
    );
    expect(executor.requests, isEmpty);
  });

  test('deny needs no verified content', () async {
    final json = approvalJson();
    final summary = summaryFor(json);
    final executor = FakeExecutor()
      ..outcomes.add(<String, Object?>{
        'approvalId': 'approval_01',
        'status': 'denied',
        'resolvedAt': 1762432860000,
      });
    final coordinator = ApprovalCommandCoordinator(
      client: executor,
      isOnline: () => true,
      verifiedSha: (approvalId) => null,
    );

    final result = await coordinator.deny(summary);

    expect(result.status, ApprovalStatus.denied);
    expect(executor.requests.single.payload['decision'], 'deny');
  });

  test('submitting disables both buttons until the first completes', () async {
    final json = approvalJson();
    final summary = summaryFor(json);
    final executor = BlockingExecutor();
    final coordinator = ApprovalCommandCoordinator(
      client: executor,
      isOnline: () => true,
      verifiedSha: (approvalId) => summary.content.sha256,
    );

    final first = coordinator.allowOnce(summary);
    await expectLater(
      coordinator.deny(summary),
      throwsA(
        isA<CommandFailure>().having(
          (error) => error.code,
          'code',
          'APPROVAL_SUBMITTING',
        ),
      ),
    );

    executor.complete(okData());
    await first;
    expect(executor.requests, hasLength(1));
  });

  test('retry reuses exactly the same commandId after a timeout', () async {
    final json = approvalJson();
    final summary = summaryFor(json);
    final executor = FakeExecutor()
      ..outcomes.add(const CommandTimeout('cmd_approval_01_0'))
      ..outcomes.add(okData());
    final coordinator = ApprovalCommandCoordinator(
      client: executor,
      isOnline: () => true,
      verifiedSha: (approvalId) => summary.content.sha256,
    );

    await expectLater(coordinator.allowOnce(summary), throwsA(isA<CommandTimeout>()));
    final result = await coordinator.retry('approval_01');

    expect(result.status, ApprovalStatus.approvedOnce);
    expect(executor.requests, hasLength(2));
    expect(
      executor.requests[0].commandId,
      executor.requests[1].commandId,
    );
  });

  test('APPROVAL_DUPLICATE_AFTER_RESOLUTION is never auto-retried', () async {
    final json = approvalJson();
    final summary = summaryFor(json);
    final executor = FakeExecutor()
      ..outcomes.add(const CommandFailure('APPROVAL_DUPLICATE_AFTER_RESOLUTION'));
    final coordinator = ApprovalCommandCoordinator(
      client: executor,
      isOnline: () => true,
      verifiedSha: (approvalId) => summary.content.sha256,
    );

    await expectLater(
      coordinator.allowOnce(summary),
      throwsA(isA<CommandFailure>()),
    );

    expect(coordinator.canSubmit('approval_01'), isFalse);
    expect(
      () => coordinator.retry('approval_01'),
      throwsA(
        isA<CommandFailure>().having(
          (error) => error.code,
          'code',
          'NO_PENDING_APPROVAL',
        ),
      ),
    );
    expect(executor.requests, hasLength(1));
  });

  test('resolved() closes the approval for further submissions', () async {
    final json = approvalJson();
    final summary = summaryFor(json);
    final coordinator = ApprovalCommandCoordinator(
      client: FakeExecutor(),
      isOnline: () => true,
      verifiedSha: (approvalId) => summary.content.sha256,
    );

    coordinator.resolved(
      'approval_01',
      const PermissionResolution(
        approvalId: 'approval_01',
        sessionId: 'session_01',
        runId: 'run_01',
        status: ApprovalStatus.denied,
        resolvedAt: 1762432860000,
        reason: ResolutionReason.userDeny,
      ),
    );

    expect(coordinator.canSubmit('approval_01'), isFalse);
  });
}

/// 第一次调用挂起，直到测试显式完成。
final class BlockingExecutor implements CommandExecutor {
  final List<CommandRequest<Object?>> requests = <CommandRequest<Object?>>[];
  final Completer<JsonMap> _gate = Completer<JsonMap>();

  void complete(JsonMap data) {
    _gate.complete(data);
  }

  @override
  Future<T> execute<T>(
    CommandRequest<T> request, {
    Duration timeout = const Duration(seconds: 10),
  }) async {
    requests.add(request);
    final data = await _gate.future;
    return request.decode(data);
  }
}