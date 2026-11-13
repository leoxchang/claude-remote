import 'package:claude_remote/domain/sync_state.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter_test/flutter_test.dart';

TimelineEvent event(int seq) {
  return TimelineEvent(
    messageId: 'msg_$seq',
    timestamp: seq,
    type: 'message.completed',
    payload: {'text': 'm$seq'},
    eventId: 'event_$seq',
    sessionId: 's1',
    seq: seq,
  );
}

void main() {
  test('afterSnapshot drains buffered events and reports them', () {
    var state = const SyncState();
    state = state.applyLive(event(2)).state;
    state = state.applyLive(event(3)).state;
    final result = state.afterSnapshotWithEvents(
      lastSeq: 1,
      events: [event(1)],
    );
    expect(result.state.lastContiguousSeq, 3);
    expect(result.applied.map((event) => event.seq), [2, 3]);
    expect(result.state.pendingBySeq, isEmpty);
  });

  test('an older snapshot does not roll the cursor back', () {
    var state = const SyncState(lastContiguousSeq: 5);
    final result = state.afterSnapshotWithEvents(
      lastSeq: 3,
      events: [event(1)],
    );
    expect(result.state.lastContiguousSeq, 5);
    expect(result.applied, isEmpty);
    state = state.withSyncing(true).clearPending();
    expect(state.syncing, isTrue);
  });

  test('duplicate pending and post-snapshot duplicates are ignored', () {
    var state = const SyncState();
    state = state.applyLive(event(2)).state;
    expect(state.applyLive(event(2)).outcome, SyncApplyOutcome.duplicate);
    state = state.afterSnapshot(lastSeq: 2, events: [event(1), event(2)]);
    expect(state.applyLive(event(1)).outcome, SyncApplyOutcome.duplicate);
    expect(
      state.applyLive(
        TimelineEvent(
          messageId: 'msg_other',
          timestamp: 1,
          type: 'message.completed',
          payload: const {},
          eventId: 'event_other',
          sessionId: 's1',
          seq: 1,
        ),
      ).outcome,
      SyncApplyOutcome.conflict,
    );
    expect(state.applyLive(event(3)).outcome, SyncApplyOutcome.applied);
  });
}
