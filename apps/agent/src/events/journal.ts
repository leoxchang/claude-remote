import { ProtocolConflictError } from '@claude-remote/protocol/timeline';

import { JsonObject } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';
import { TimelineEvent } from './adapter-events.js';

const EVENT_ID_BYTES = 9;

/** 追加事件的输入；eventId 缺省时自动生成。 */
export interface JournalAppendInput {
  sessionId: string;
  type: string;
  payload: JsonObject;
  eventId?: string;
  runId?: string;
  approvalId?: string;
}

/**
 * 内存事件日志：先分配 eventId/seq，再通知订阅者。
 *
 * @deprecated S04 起运行时只 wiring DurableEventJournal；本类仅保留给
 * S01–S03 的历史测试，不得双写或双读。
 */
export class EventJournal {
  private readonly eventsBySession = new Map<string, TimelineEvent[]>();
  private readonly seqBySession = new Map<string, number>();
  private readonly eventsById = new Map<string, TimelineEvent>();
  private readonly listeners = new Set<(event: TimelineEvent) => void>();

  /** 追加一条事件；同一 eventId 重传返回原事件，跨会话或内容不同则冲突。 */
  append(input: JournalAppendInput): TimelineEvent {
    const events = this.eventsBySession.get(input.sessionId) ?? [];
    const eventId = input.eventId ?? `event_${randomBase64Url(EVENT_ID_BYTES)}`;
    const existing = this.eventsById.get(eventId);
    if (existing !== undefined) {
      const sameContent =
        existing.sessionId === input.sessionId &&
        existing.type === input.type &&
        JSON.stringify(existing.payload) === JSON.stringify(input.payload);
      if (!sameContent) {
        throw new ProtocolConflictError(
          'event id reused with different content',
        );
      }
      return existing;
    }

    const seq = (this.seqBySession.get(input.sessionId) ?? 0) + 1;
    this.seqBySession.set(input.sessionId, seq);
    const event: TimelineEvent = {
      protocolVersion: 1,
      messageId: `msg_${eventId}`,
      timestamp: Date.now(),
      type: input.type,
      payload: input.payload,
      eventId,
      sessionId: input.sessionId,
      seq,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    };
    this.eventsBySession.set(input.sessionId, [...events, event]);
    this.eventsById.set(eventId, event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** 最近 limit 条事件，按 seq 升序。 */
  recent(sessionId: string, limit: number): TimelineEvent[] {
    const events = this.eventsBySession.get(sessionId) ?? [];
    return events.slice(Math.max(0, events.length - limit));
  }

  /** 订阅新事件；返回取消订阅函数。 */
  subscribe(listener: (event: TimelineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 当前最大 seq；没有事件为 0。 */
  lastSeq(sessionId: string): number {
    return this.seqBySession.get(sessionId) ?? 0;
  }
}