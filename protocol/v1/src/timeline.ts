/** 时间线归一化时发现的协议冲突。 */
export class ProtocolConflictError extends Error {
  readonly code = 'PROTOCOL_CONFLICT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ProtocolConflictError';
  }
}

interface TimelineEvent {
  eventId: string;
  sessionId: string;
  seq: number;
}

/**
 * 按 eventId 去重、检查冲突，再按 seq 升序返回新数组。
 * 不依赖 timestamp，也不修改输入数组或事件对象。
 */
export function normalizeTimeline<T extends TimelineEvent>(
  events: readonly T[],
): T[] {
  const byEventId = new Map<string, T>();
  for (const event of events) {
    const existing = byEventId.get(event.eventId);
    if (existing === undefined) {
      byEventId.set(event.eventId, event);
      continue;
    }
    if (!sameContent(existing, event)) {
      throw new ProtocolConflictError(
        `eventId ${event.eventId} was retransmitted with different content`,
      );
    }
  }

  const unique = [...byEventId.values()];
  const sessionIds = new Set(unique.map((event) => event.sessionId));
  if (sessionIds.size > 1) {
    throw new ProtocolConflictError(
      `timeline mixes multiple sessions: ${[...sessionIds].join(', ')}`,
    );
  }

  const sorted = [...unique].sort((left, right) => left.seq - right.seq);

  const eventIdBySeq = new Map<number, string>();
  for (const event of sorted) {
    const otherEventId = eventIdBySeq.get(event.seq);
    if (otherEventId !== undefined && otherEventId !== event.eventId) {
      throw new ProtocolConflictError(
        `seq ${event.seq} is used by both ${otherEventId} and ${event.eventId}`,
      );
    }
    eventIdBySeq.set(event.seq, event.eventId);
  }

  return sorted;
}

function sameContent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}