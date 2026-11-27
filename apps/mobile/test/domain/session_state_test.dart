import 'package:claude_remote/domain/run.dart';
import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/domain/session_state.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter_test/flutter_test.dart';

TimelineEvent event({
  required String type,
  String? runId,
  Map<String, Object?> payload = const <String, Object?>{},
  int seq = 1,
}) {
  return TimelineEvent(
    messageId: 'msg_$seq',
    timestamp: 0,
    type: type,
    payload: payload,
    eventId: 'evt_$seq',
    sessionId: 'session_a',
    seq: seq,
    runId: runId,
  );
}

SessionState base({String status = 'idle'}) => SessionState(
      sessionId: 'session_a',
      workspaceId: 'ws_alpha',
      title: 'Alpha',
      status: status,
    );

void main() {
  test('snapshot replaces volatile state of the target session', () {
    final state = applySnapshotToSession(
      base(),
      SessionSnapshot(
        sessionId: 'session_a',
        events: const <TimelineEvent>[],
        lastSeq: 5,
        sessionStatus: 'running',
        title: 'Renamed',
        claudeSessionId: 'claude_1',
        activeRunId: 'run_9',
        activeRunStatus: RunStatus.running,
        queuedRuns: const <QueuedRunSummary>[
          QueuedRunSummary(runId: 'run_10', commandId: 'cmd_10', enqueuedAt: 10),
        ],
        globalCapacity: const GlobalCapacity(activeRunCount: 2, maxActiveRuns: 2),
      ),
    );

    expect(state.title, 'Renamed');
    expect(state.status, 'running');
    expect(state.claudeSessionId, 'claude_1');
    expect(state.activeRunId, 'run_9');
    expect(state.activeRunStatus, RunStatus.running);
    expect(state.queue.single.runId, 'run_10');
    expect(state.globalCapacity.isFull, isTrue);
  });

  test('run.started moves the head from queue to activeRun', () {
    final queued = applyEventToSession(
      base(),
      event(type: 'run.queued', runId: 'run_1', payload: {'enqueuedAt': 1}),
    );

    final started = applyEventToSession(
      queued,
      event(type: 'run.started', runId: 'run_1', payload: {'status': 'starting'}),
    );

    expect(started.queue, isEmpty);
    expect(started.activeRunId, 'run_1');
    expect(started.activeRunStatus, RunStatus.starting);
    expect(started.status, 'running');
  });

  test('run.completed keeps queued followers visible', () {
    var state = base();
    state = applyEventToSession(
      state,
      event(type: 'run.queued', runId: 'run_1', payload: {'enqueuedAt': 1}),
    );
    state = applyEventToSession(
      state,
      event(type: 'run.started', runId: 'run_1', payload: {'status': 'starting'}),
    );
    state = applyEventToSession(
      state,
      event(type: 'run.queued', runId: 'run_2', payload: {'enqueuedAt': 2}),
    );

    state = applyEventToSession(
      state,
      event(type: 'run.completed', runId: 'run_1', payload: {'status': 'cancelled'}),
    );

    expect(state.activeRunId, isNull);
    expect(state.status, 'queued');
    expect(state.queue.single.runId, 'run_2');
    expect(state.lastRunStatus, RunStatus.cancelled);
  });

  test('archived sessions stay archived and read-only', () {
    final archived = applyEventToSession(
      base(status: 'archived'),
      event(type: 'run.queued', runId: 'run_1', payload: {'enqueuedAt': 1}),
    );

    expect(archived.status, 'archived');
    expect(archived.isArchived, isTrue);

    final snapshot = applySnapshotToSession(
      archived,
      SessionSnapshot(
        sessionId: 'session_a',
        events: const <TimelineEvent>[],
        lastSeq: 1,
        sessionStatus: 'archived',
      ),
    );
    expect(snapshot.status, 'archived');
  });

  test('session.status carries the active run identity', () {
    final state = applyEventToSession(
      base(),
      event(
        type: 'session.status',
        payload: {'state': 'running', 'activeRunId': 'run_1'},
      ),
    );

    expect(state.status, 'running');
    expect(state.activeRunId, 'run_1');
  });

  test('session.status with model updates the session model', () {
    final next = applyEventToSession(
      base(),
      event(type: 'session.status', payload: {'state': 'idle', 'model': 'opus'}),
    );

    expect(next.model, 'opus');
  });

  test('session.status without model keeps the previous model', () {
    final withModel = applyEventToSession(
      base(),
      event(type: 'session.status', payload: {'state': 'idle', 'model': 'opus'}),
    );
    final next = applyEventToSession(
      withModel,
      event(type: 'session.status', payload: {'state': 'running'}),
    );

    expect(next.model, 'opus');
  });

  test('session.status with explicit null clears the model', () {
    final withModel = applyEventToSession(
      base(),
      event(type: 'session.status', payload: {'state': 'idle', 'model': 'opus'}),
    );
    final next = applyEventToSession(
      withModel,
      event(type: 'session.status', payload: {'state': 'idle', 'model': null}),
    );

    expect(next.model, isNull);
  });

  test('snapshot model applies explicit null and keeps on missing key', () {
    final withModel = applyEventToSession(
      base(),
      event(type: 'session.status', payload: {'state': 'idle', 'model': 'opus'}),
    );

    final cleared = applySnapshotToSession(
      withModel,
      SessionSnapshot(
        sessionId: 'session_a',
        events: const <TimelineEvent>[],
        lastSeq: 1,
        model: null,
        hasModel: true,
      ),
    );
    expect(cleared.model, isNull);

    final kept = applySnapshotToSession(
      withModel,
      SessionSnapshot(
        sessionId: 'session_a',
        events: const <TimelineEvent>[],
        lastSeq: 1,
      ),
    );
    expect(kept.model, 'opus');
  });

  test('SessionSummary.fromWire parses the session model', () {
    final summary = SessionSummary.fromWire(<String, Object?>{
      'sessionId': 's1',
      'workspaceId': 'ws',
      'title': 'T',
      'createdAt': 1,
      'lastActivityAt': 2,
      'model': 'opus',
    });
    expect(summary.model, 'opus');

    final plain = SessionSummary.fromWire(<String, Object?>{
      'sessionId': 's1',
      'workspaceId': 'ws',
      'title': 'T',
      'createdAt': 1,
      'lastActivityAt': 2,
    });
    expect(plain.model, isNull);
  });

  test('SessionSummary copyWith sets and explicitly clears the model', () {
    const summary = SessionSummary(
      sessionId: 's1',
      workspaceId: 'ws',
      title: 'T',
      createdAt: 0,
      lastActivityAt: 0,
      model: 'opus',
    );

    expect(summary.copyWith(model: 'sonnet').model, 'sonnet');
    expect(summary.copyWith(model: null).model, 'opus');
    expect(summary.copyWith(clearModel: true).model, isNull);
  });
}