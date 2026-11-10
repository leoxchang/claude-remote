import { describe, expect, it, vi } from 'vitest';

import { ProtocolConflictError } from '@claude-remote/protocol/timeline';
import { JsonObject } from '../src/domain/types.js';
import { EventJournal } from '../src/events/journal.js';

const append = (journal: EventJournal, payload: JsonObject, eventId?: string) =>
  journal.append({
    sessionId: 'session_01',
    type: 'message.delta',
    payload,
    ...(eventId === undefined ? {} : { eventId }),
  });

describe('EventJournal', () => {
  it('assigns consecutive seq per session', () => {
    const journal = new EventJournal();

    const first = append(journal, { text: 'a' });
    const second = append(journal, { text: 'b' });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(journal.lastSeq('session_01')).toBe(2);
    expect(journal.lastSeq('session_other')).toBe(0);
  });

  it('returns the original event when the same eventId is retransmitted', () => {
    const journal = new EventJournal();
    const first = append(journal, { text: 'a' }, 'event_1');

    const again = append(journal, { text: 'a' }, 'event_1');

    expect(again).toEqual(first);
    expect(journal.recent('session_01', 10)).toHaveLength(1);
    expect(journal.lastSeq('session_01')).toBe(1);
  });

  it('rejects an eventId reused with different content', () => {
    const journal = new EventJournal();
    append(journal, { text: 'a' }, 'event_1');

    expect(() => append(journal, { text: 'b' }, 'event_1')).toThrow(
      ProtocolConflictError,
    );
  });

  it('returns the most recent events in ascending order', () => {
    const journal = new EventJournal();
    for (let index = 0; index < 5; index += 1) {
      append(journal, { text: String(index) });
    }

    const recent = journal.recent('session_01', 2);

    expect(recent.map((event) => event.seq)).toEqual([4, 5]);
  });

  it('notifies subscribers until they unsubscribe', () => {
    const journal = new EventJournal();
    const listener = vi.fn();
    const unsubscribe = journal.subscribe(listener);

    append(journal, { text: 'a' });
    unsubscribe();
    append(journal, { text: 'b' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps sessions isolated', () => {
    const journal = new EventJournal();
    append(journal, { text: 'a' });
    journal.append({ sessionId: 'session_02', type: 'message.delta', payload: { text: 'b' } });

    expect(journal.recent('session_01', 10)).toHaveLength(1);
    expect(journal.recent('session_02', 10)).toHaveLength(1);
  });
});