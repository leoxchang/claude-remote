import 'package:claude_remote/domain/app_state.dart';
import 'package:claude_remote/domain/run.dart';
import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/protocol/envelope.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter_test/flutter_test.dart';

TimelineEvent event({
  required String sessionId,
  required int seq,
  String type = 'message.delta',
  Map<String, Object?>? payload,
  String? runId,
  String? eventId,
}) {
  return TimelineEvent(
    messageId: 'msg_$sessionId-$seq',
    timestamp: 0,
    type: type,
    payload: payload ?? {'assistantMessageId': 'm1', 'text': 'x'},
    eventId: eventId ?? 'evt_$sessionId-$seq',
    sessionId: sessionId,
    seq: seq,
    runId: runId,
  );
}

SessionSnapshot snapshot({
  required String sessionId,
  int lastSeq = 0,
  List<TimelineEvent> events = const <TimelineEvent>[],
  List<QueuedRunSummary> queued = const <QueuedRunSummary>[],
  GlobalCapacity? capacity,
  String? status,
  String? title,
  String? activeRunId,
}) {
  return SessionSnapshot(
    sessionId: sessionId,
    events: events,
    lastSeq: lastSeq,
    queuedRuns: queued,
    globalCapacity: capacity,
    sessionStatus: status,
    title: title,
    activeRunId: activeRunId,
  );
}

void main() {
  test('same seq in two sessions is legal and snapshot only replaces its target', () {
    var state = AppState.initial();
    state = applyTimelineEvent(state, event(sessionId: 'a', seq: 1));
    state = applyTimelineEvent(state, event(sessionId: 'b', seq: 1));
    final beforeB = state.timelinesBySessionId['b'];

    state = applySessionSnapshot(state, snapshot(sessionId: 'a'));

    expect(state.timelinesBySessionId['b'], same(beforeB));
    expect(
      state.timelinesBySessionId.keys,
      containsAll(<String>['a', 'b']),
    );
  });

  test('dedupes identical event ids and rejects conflicting ones', () {
    var state = AppState.initial();
    final first = event(sessionId: 'a', seq: 1);
    state = applyTimelineEvent(state, first);
    final timeline = state.timelinesBySessionId['a'];
    state = applyTimelineEvent(state, first);

    expect(state.timelinesBySessionId['a'], same(timeline));
    expect(
      () => applyTimelineEvent(
        state,
        event(
          sessionId: 'a',
          seq: 2,
          eventId: first.eventId,
          payload: {'assistantMessageId': 'm1', 'text': 'different'},
        ),
      ),
      throwsA(isA<ProtocolConflictException>()),
    );
  });

  test('tracks run.queued, run.started and run.completed per session', () {
    var state = AppState.initial();
    state = applyTimelineEvent(
      state,
      event(
        sessionId: 'a',
        seq: 1,
        type: 'run.queued',
        runId: 'run_1',
        payload: {'enqueuedAt': 100, 'waitReason': 'GLOBAL_CAPACITY'},
      ),
    );
    expect(state.sessionStatesById['a']?.queue.single.runId, 'run_1');
    expect(state.sessionStatesById['a']?.status, 'queued');

    state = applyTimelineEvent(
      state,
      event(
        sessionId: 'a',
        seq: 2,
        type: 'run.started',
        runId: 'run_1',
        payload: {'startedAt': 101, 'status': 'starting'},
      ),
    );
    expect(state.sessionStatesById['a']?.queue, isEmpty);
    expect(state.sessionStatesById['a']?.activeRunId, 'run_1');
    expect(state.sessionStatesById['a']?.status, 'running');

    state = applyTimelineEvent(
      state,
      event(
        sessionId: 'a',
        seq: 3,
        type: 'run.completed',
        runId: 'run_1',
        payload: {'status': 'succeeded'},
      ),
    );
    expect(state.sessionStatesById['a']?.activeRunId, isNull);
    expect(state.sessionStatesById['a']?.status, 'idle');
    expect(state.sessionStatesById['a']?.lastRunStatus, RunStatus.succeeded);
  });

  test('keeps queued FIFO order independent of event arrival interleaving', () {
    var state = AppState.initial();
    state = applyTimelineEvent(
      state,
      event(
        sessionId: 'a',
        seq: 1,
        type: 'run.queued',
        runId: 'run_1',
        payload: {'enqueuedAt': 1},
      ),
    );
    state = applyTimelineEvent(
      state,
      event(
        sessionId: 'a',
        seq: 2,
        type: 'run.queued',
        runId: 'run_2',
        payload: {'enqueuedAt': 2},
      ),
    );

    expect(
      state.sessionStatesById['a']?.queue.map((run) => run.runId).toList(),
      <String>['run_1', 'run_2'],
    );
  });

  test('snapshot queue and capacity replace the target session only', () {
    var state = AppState.initial();
    state = applyTimelineEvent(
      state,
      event(
        sessionId: 'a',
        seq: 1,
        type: 'run.queued',
        runId: 'run_1',
        payload: {'enqueuedAt': 1, 'waitReason': 'GLOBAL_CAPACITY'},
      ),
    );
    expect(state.sessionStatesById['a']?.globalCapacity.activeRunCount, 0);

    state = applySessionSnapshot(
      state,
      snapshot(
        sessionId: 'a',
        lastSeq: 3,
        status: 'queued',
        title: 'Alpha',
        queued: const <QueuedRunSummary>[
          QueuedRunSummary(runId: 'run_7', commandId: 'cmd_7', enqueuedAt: 7),
        ],
        capacity: const GlobalCapacity(activeRunCount: 1, maxActiveRuns: 2),
      ),
    );

    expect(state.sessionStatesById['a']?.queue.single.runId, 'run_7');
    expect(state.sessionStatesById['a']?.globalCapacity.activeRunCount, 1);
    expect(state.sessionStatesById['a']?.title, 'Alpha');
    expect(state.sessionStatesById['a']?.status, 'queued');

    state = applyTimelineEvent(
      state,
      event(
        sessionId: 'a',
        seq: 4,
        type: 'run.queued',
        runId: 'run_8',
        payload: {'enqueuedAt': 8},
      ),
    );
    expect(state.sessionStatesById['a']?.globalCapacity.activeRunCount, 1);
  });

  test('unknown session events are stored without changing the selection', () {
    var state = AppState.initial()
        .updateDraft('a', 'draft-a')
        .selectSession('a');

    state = applyTimelineEvent(state, event(sessionId: 'b', seq: 1));

    expect(state.selectedSessionId, 'a');
    expect(state.timelinesBySessionId.containsKey('b'), isTrue);
    expect(state.composerDraftsBySessionId['a'], 'draft-a');
    expect(state.composerDraftsBySessionId.containsKey('b'), isFalse);
  });

  test('keeps composer drafts independent per session', () {
    var state = AppState.initial()
        .updateDraft('a', 'alpha')
        .updateDraft('b', 'beta');

    state = state.selectSession('a');

    expect(state.draftFor('a'), 'alpha');
    expect(state.draftFor('b'), 'beta');
  });

  test('new agent instance clears conversational state but keeps drafts', () {
    var state = AppState.initial()
        .updateDraft('a', 'draft')
        .selectSession('a');
    state = applyTimelineEvent(state, event(sessionId: 'a', seq: 1));

    state = applyAgentInstance(state, 'agent_2');

    expect(state.agentInstanceId, 'agent_2');
    expect(state.timelinesBySessionId, isEmpty);
    expect(state.sessionStatesById, isEmpty);
    expect(state.selectedSessionId, isNull);
    expect(state.composerDraftsBySessionId['a'], 'draft');
  });

  test('evicts idle timelines but keeps active and selected sessions', () {
    var state = AppState.initial().selectSession('a');
    state = applyTimelineEvent(state, event(sessionId: 'a', seq: 1));
    state = applyTimelineEvent(state, event(sessionId: 'b', seq: 1));
    state = applyTimelineEvent(
      state,
      event(
        sessionId: 'c',
        seq: 1,
        type: 'run.queued',
        runId: 'run_1',
        payload: {'enqueuedAt': 1},
      ),
    );

    state = evictIdleTimelines(state);

    expect(
      state.timelinesBySessionId.keys,
      containsAll(<String>['a', 'c']),
    );
    expect(state.timelinesBySessionId.containsKey('b'), isFalse);
    expect(state.sessionStatesById.containsKey('b'), isTrue);
  });
}