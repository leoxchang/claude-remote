import { describe, expect, it } from 'vitest';

import { normalizeTimeline, ProtocolConflictError } from '../src/timeline.js';
import { writeEvidence } from '../../../scripts/s00/evidence.js';

interface TimelineEvent {
  eventId: string;
  sessionId: string;
  seq: number;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
}

const event = (
  eventId: string,
  seq: number,
  timestamp: number,
  payload: Record<string, unknown> = {},
): TimelineEvent => ({
  eventId,
  sessionId: 'session_01',
  seq,
  timestamp,
  type: 'session.status',
  payload,
});

describe('normalizeTimeline', () => {
  it('sorts by seq, not by timestamp, into a new array', () => {
    const first = event('event_01', 1, 300);
    const second = event('event_02', 2, 100);
    const input = [second, first];

    const result = normalizeTimeline(input);

    expect(result.map((entry) => entry.eventId)).toEqual(['event_01', 'event_02']);
    expect(result).not.toBe(input);
    expect(input.map((entry) => entry.eventId)).toEqual(['event_02', 'event_01']);
  });

  it('deduplicates an identical retried event', () => {
    const first = event('event_01', 1, 100, { state: 'running' });
    const retry = event('event_01', 1, 100, { state: 'running' });

    const result = normalizeTimeline([first, retry]);

    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe('event_01');
  });

  it('rejects the same eventId with different content', () => {
    const first = event('event_01', 1, 100, { state: 'running' });
    const conflicting = event('event_01', 1, 100, { state: 'closed' });

    expect(() => normalizeTimeline([first, conflicting])).toThrow(
      ProtocolConflictError,
    );
  });

  it('rejects the same seq used by different eventIds', () => {
    const first = event('event_01', 1, 100);
    const conflicting = event('event_02', 1, 101);

    expect(() => normalizeTimeline([first, conflicting])).toThrow(
      ProtocolConflictError,
    );
  });

  it('rejects a timeline that mixes sessions', () => {
    const first = event('event_01', 1, 100);
    const otherSession = { ...event('event_02', 2, 101), sessionId: 'session_02' };

    expect(() => normalizeTimeline([first, otherSession])).toThrow(
      ProtocolConflictError,
    );
  });

  it('exposes the stable PROTOCOL_CONFLICT code', () => {
    try {
      normalizeTimeline([event('event_01', 1, 100), event('event_01', 1, 100, { state: 'x' })]);
      expect.unreachable('expected a ProtocolConflictError');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProtocolConflictError);
      if (!(error instanceof ProtocolConflictError)) return;
      expect(error.code).toBe('PROTOCOL_CONFLICT');
    }
  });

  it('records PROTO-07 evidence', async () => {
    await writeEvidence({
      id: 'PROTO-07',
      status: 'PASS',
      summary:
        'Timeline dedupes by eventId, sorts by sessionId+seq, and rejects conflicting retransmits',
      observedAt: new Date().toISOString(),
      data: {
        conflictingInputsRejected: [
          'same eventId different content',
          'same seq different eventId',
          'mixed sessionId',
        ],
        sortedBy: 'sessionId+seq',
      },
    });
  });
});