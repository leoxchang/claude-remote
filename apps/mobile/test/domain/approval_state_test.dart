import 'package:claude_remote/domain/app_state.dart';
import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/domain/session_state.dart';
import 'package:claude_remote/protocol/envelope.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> _contentDescriptor() => const <String, Object?>{
      'encoding': 'json-utf8',
      'byteLength': 18342,
      'sha256': 'hash_01',
      'chunkCount': 1,
    };

TimelineEvent requested({
  required String sessionId,
  required String approvalId,
  required int seq,
  String eventId = '',
  String runId = 'run_01',
  String toolName = 'Bash',
}) {
  return TimelineEvent(
    messageId: 'msg_$approvalId',
    timestamp: 1762432800000,
    type: 'permission.requested',
    payload: {
      'workspaceId': 'ws_01',
      'toolUseID': 'toolu_$approvalId',
      'toolName': toolName,
      'agentID': null,
      'createdAt': 1762432800000,
      'expiresAt': 1762432920000,
      'defaultToNo': false,
      'content': _contentDescriptor(),
    },
    eventId: eventId.isEmpty ? 'event_req_$approvalId' : eventId,
    sessionId: sessionId,
    seq: seq,
    runId: runId,
    approvalId: approvalId,
  );
}

TimelineEvent resolved({
  required String sessionId,
  required String approvalId,
  required int seq,
  String eventId = '',
  String status = 'denied',
  String reason = 'user_deny',
}) {
  return TimelineEvent(
    messageId: 'msg_res_$approvalId',
    timestamp: 1762432860000,
    type: 'permission.resolved',
    payload: {
      'status': status,
      'resolvedAt': 1762432860000,
      'resolutionReason': reason,
      'responseCommandId': 'cmd_02',
    },
    eventId: eventId.isEmpty ? 'event_res_$approvalId' : eventId,
    sessionId: sessionId,
    seq: seq,
    runId: 'run_01',
    approvalId: approvalId,
  );
}

void main() {
  test('approval routes remain isolated and snapshots replace only their target', () {
    var state = AppState.initial();
    state = applyApprovalEvent(state, requested(sessionId: 'a', approvalId: 'p1', seq: 1));
    state = applyApprovalEvent(state, requested(sessionId: 'b', approvalId: 'p2', seq: 1));
    state = applyApprovalEvent(state, resolved(sessionId: 'a', approvalId: 'p1', seq: 2));

    expect(state.pendingApprovalsById.keys, ['p2']);
    expect(state.pendingApprovalsById['p1'], isNull);
    expect(state.approvalIdsBySessionId['a'], isEmpty);
    expect(state.approvalIdsBySessionId['b'], ['p2']);
  });

  test('deduplicates eventId and rejects conflicting retransmission', () {
    var state = AppState.initial();
    final event = requested(sessionId: 'a', approvalId: 'p1', seq: 1);
    state = applyApprovalEvent(state, event);
    final same = applyApprovalEvent(state, event);
    expect(identical(same, state), isTrue);

    final conflicting = TimelineEvent(
      messageId: event.messageId,
      timestamp: event.timestamp,
      type: event.type,
      payload: {...event.payload, 'toolName': 'Edit'},
      eventId: event.eventId,
      sessionId: event.sessionId,
      seq: event.seq,
      runId: event.runId,
      approvalId: event.approvalId,
    );
    expect(
      () => applyApprovalEvent(state, conflicting),
      throwsA(isA<ProtocolConflictException>()),
    );
  });

  test('rejects the same approvalId arriving for two sessions', () {
    var state = AppState.initial();
    state = applyApprovalEvent(state, requested(sessionId: 'a', approvalId: 'p1', seq: 1));

    expect(
      () => applyApprovalEvent(
        state,
        requested(sessionId: 'b', approvalId: 'p1', seq: 1, eventId: 'event_other'),
      ),
      throwsA(isA<ProtocolConflictException>()),
    );
  });

  test('resolved for an unknown approval changes nothing and does not throw', () {
    var state = AppState.initial();
    state = applyApprovalEvent(state, requested(sessionId: 'a', approvalId: 'p1', seq: 1));
    final next = applyApprovalEvent(
      state,
      resolved(sessionId: 'a', approvalId: 'p9', seq: 2),
    );

    expect(next.pendingApprovalsById.keys, ['p1']);
  });

  test('malformed approval events fail closed', () {
    final broken = TimelineEvent(
      messageId: 'msg_broken',
      timestamp: 1762432800000,
      type: 'permission.requested',
      payload: const <String, Object?>{
        'toolUseID': 'toolu_1',
        'toolName': 'Bash',
        'createdAt': 1762432800000,
        'expiresAt': 1762432920000,
        'defaultToNo': false,
      },
      eventId: 'event_broken',
      sessionId: 'a',
      seq: 1,
      runId: 'run_01',
      approvalId: 'p1',
    );
    expect(
      () => applyApprovalEvent(AppState.initial(), broken),
      throwsA(isA<ProtocolConflictException>()),
    );
  });

  test('snapshot replaces only the target session pending approvals', () {
    var state = AppState.initial();
    state = applyApprovalEvent(state, requested(sessionId: 'a', approvalId: 'p1', seq: 1));
    state = applyApprovalEvent(state, requested(sessionId: 'b', approvalId: 'p2', seq: 1));

    final snapshot = SessionSnapshot.fromPayload(<String, Object?>{
      'lastSeq': 2,
      'session': <String, Object?>{
        'sessionId': 'a',
        'workspaceId': 'ws_01',
        'title': 'A',
        'status': 'waiting_approval',
      },
      'activeRun': <String, Object?>{
        'runId': 'run_01',
        'status': 'waiting_approval',
        'pendingApprovalCount': 1,
      },
      'pendingApprovals': <Object?>[
        <String, Object?>{
          'approvalId': 'p3',
          'toolUseID': 'toolu_3',
          'toolName': 'Edit',
          'createdAt': 1762432800000,
          'expiresAt': 1762432920000,
          'defaultToNo': true,
          'content': _contentDescriptor(),
        },
      ],
      'queuedRuns': <Object?>[],
      'recentEvents': <Object?>[],
    });

    final next = applySessionSnapshot(state, snapshot);

    expect(next.pendingApprovalsById.keys, unorderedEquals(['p2', 'p3']));
    expect(next.approvalIdsBySessionId['a'], ['p3']);
    expect(next.approvalIdsBySessionId['b'], ['p2']);
    expect(next.sessionStatesById['a']?.status, 'waiting_approval');
    expect(next.sessionStatesById['a']?.pendingApprovalCount, 1);
  });

  test('agent instance change clears approvals and pending counts', () {
    var state = AppState.initial();
    state = applyApprovalEvent(state, requested(sessionId: 'a', approvalId: 'p1', seq: 1));
    final next = applyAgentInstance(state, 'agent_02');

    expect(next.pendingApprovalsById, isEmpty);
    expect(next.approvalIdsBySessionId, isEmpty);
  });

  test('session.status waiting_approval carries the pending count', () {
    final base = SessionState(sessionId: 'a', workspaceId: 'ws_01');
    final next = applyEventToSession(
      base,
      TimelineEvent(
        messageId: 'msg_status',
        timestamp: 1762432800000,
        type: 'session.status',
        payload: const <String, Object?>{
          'state': 'waiting_approval',
          'status': 'waiting_approval',
          'activeRunId': 'run_01',
          'pendingApprovalCount': 2,
        },
        eventId: 'event_status',
        sessionId: 'a',
        seq: 1,
        runId: 'run_01',
      ),
    );

    expect(next.status, 'waiting_approval');
    expect(next.activeRunStatus?.wireName, 'waiting_approval');
    expect(next.pendingApprovalCount, 2);
  });
}