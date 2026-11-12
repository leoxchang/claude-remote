import { describe, expect, it } from 'vitest';

import { EventJournal } from '../src/events/journal.js';

describe('EventJournal per-session isolation', () => {
  it('numbers seq independently per session', () => {
    const journal = new EventJournal();

    const a = journal.append({ sessionId: 'session_a', type: 'message.delta', payload: { text: 'a' } });
    const b = journal.append({ sessionId: 'session_b', type: 'message.delta', payload: { text: 'b' } });

    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
    expect(journal.lastSeq('session_a')).toBe(1);
    expect(journal.lastSeq('session_b')).toBe(1);
  });

  it('keeps recent events scoped to the requested session', () => {
    const journal = new EventJournal();
    journal.append({ sessionId: 'session_a', type: 'message.delta', payload: { text: 'a1' } });
    journal.append({ sessionId: 'session_b', type: 'message.delta', payload: { text: 'b1' } });
    journal.append({ sessionId: 'session_a', type: 'message.delta', payload: { text: 'a2' } });

    const recent = journal.recent('session_a', 10);

    expect(recent.map((event) => event.seq)).toEqual([1, 2]);
    expect(
      recent.map((event) => (event.payload as Record<string, unknown>)['text']),
    ).toEqual(['a1', 'a2']);
  });

  it('rejects a reused eventId in another session', () => {
    const journal = new EventJournal();
    journal.append({
      sessionId: 'session_a',
      type: 'message.delta',
      payload: { text: 'a' },
      eventId: 'event_shared',
    });

    expect(() =>
      journal.append({
        sessionId: 'session_b',
        type: 'message.delta',
        payload: { text: 'b' },
        eventId: 'event_shared',
      }),
    ).toThrow();
  });

  it('replays an identical eventId within the same session', () => {
    const journal = new EventJournal();
    const first = journal.append({
      sessionId: 'session_a',
      type: 'message.delta',
      payload: { text: 'a' },
      eventId: 'event_same',
    });
    const replay = journal.append({
      sessionId: 'session_a',
      type: 'message.delta',
      payload: { text: 'a' },
      eventId: 'event_same',
    });

    expect(replay).toBe(first);
    expect(journal.lastSeq('session_a')).toBe(1);
  });
});