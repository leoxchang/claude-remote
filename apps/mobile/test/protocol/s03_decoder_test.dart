import 'dart:convert';
import 'dart:io';

import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/protocol/decoder.dart';
import 'package:claude_remote/protocol/envelope.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:claude_remote/protocol/s03_messages.dart';
import 'package:flutter_test/flutter_test.dart';

const examplesDir = '../../protocol/v1/examples/s03';

String readExample(String name) =>
    File('$examplesDir/$name').readAsStringSync();

void main() {
  test('decodes every shared S03 protocol example', () {
    for (final name in <String>[
      'permission-requested.json',
      'permission-resolved.json',
      'permission-respond.json',
      'duplicate-after-resolution.json',
      'unsupported-interaction.json',
      'session-snapshot.json',
    ]) {
      final message = ProtocolDecoder.decode(readExample(name));
      expect(message.type, isNotEmpty, reason: name);
    }
  });

  test('decodes permission.respond with every association id', () {
    final message = ProtocolDecoder.decode(readExample('permission-respond.json'));
    expect(message, isA<CommandMessage>());
    final command = message as CommandMessage;
    expect(command.type, 'permission.respond');
    expect(command.approvalId, 'approval_01');
    expect(command.sessionId, 'session_01');
    expect(command.runId, 'run_01');
    expect(command.workspaceId, 'ws_01');
    expect(command.payload['decision'], 'allow_once');
  });

  test('decodes permission.requested into a safe summary', () {
    final event = ProtocolDecoder.decode(readExample('permission-requested.json'));
    expect(event, isA<TimelineEvent>());
    final timeline = event as TimelineEvent;
    expect(timeline.approvalId, 'approval_01');

    final summary = ApprovalSummary.fromEvent(timeline);
    expect(summary, isNotNull);
    expect(summary!.approvalId, 'approval_01');
    expect(summary.toolName, 'Edit');
    expect(summary.toolUseId, 'toolu_01');
    expect(summary.defaultToNo, isFalse);
    expect(summary.content.sha256, isNotEmpty);
    expect(summary.content.chunkCount, 1);
    expect(timeline.payload.containsKey('input'), isFalse);
  });

  test('decodes permission.resolved into an immutable resolution', () {
    final event = ProtocolDecoder.decode(readExample('permission-resolved.json'));
    final timeline = event as TimelineEvent;
    final resolution = PermissionResolution.fromEvent(timeline);

    expect(resolution, isNotNull);
    expect(resolution!.status, ApprovalStatus.approvedOnce);
    expect(resolution.reason, ResolutionReason.userAllowOnce);
    expect(resolution.responseCommandId, 'cmd_02');
  });

  test('parses snapshot pending approvals with fallback ids', () {
    final snapshot = ProtocolDecoder.decode(readExample('session-snapshot.json'));
    final parsed = SessionSnapshot.fromPayload(
      (snapshot as ControlMessage).payload,
    );

    expect(parsed.hasPendingApprovals, isTrue);
    expect(parsed.pendingApprovals, hasLength(1));
    final pending = parsed.pendingApprovals.first;
    expect(pending.approvalId, 'approval_01');
    expect(pending.sessionId, 'session_01');
    expect(pending.workspaceId, 'ws_01');
    expect(pending.runId, 'run_01');
    expect(parsed.sessionStatus, 'waiting_approval');
    expect(parsed.activeRunStatus?.wireName, 'waiting_approval');
    expect(parsed.pendingApprovalCount, 1);
  });

  test('fails closed on an unknown permission event', () {
    final unknown = {
      'protocolVersion': 1,
      'messageId': 'msg_unknown',
      'timestamp': 1762432800000,
      'type': 'permission.future',
      'eventId': 'event_unknown',
      'sessionId': 'session_01',
      'seq': 1,
      'payload': <String, Object?>{},
    };
    expect(
      () => ProtocolDecoder.decode(
        const JsonEncoder().convert(unknown),
      ),
      throwsA(isA<ProtocolConflictException>()),
    );
  });
}