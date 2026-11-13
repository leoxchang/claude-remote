import { TimelineEvent } from '../events/adapter-events.js';
import { AppendEvent, EventAppender } from '../storage/persistent-command-executor.js';
import {
  EventAppendInput,
  EventRepository,
} from '../storage/repositories/event-repository.js';
import { SqliteTransaction, UnitOfWork } from '../storage/unit-of-work.js';

export interface DurableEventJournalOptions {
  now?: () => number;
  generateEventId?: () => string;
}

/**
 * S04 权威事件日志：事务内只写 DB，commit 后才发布。
 *
 * 发布失败不影响 afterSeq；旧 EventJournal 不再作为运行时路径。
 */
export class DurableEventJournal implements EventAppender {
  private readonly events: EventRepository;
  private readonly listeners = new Set<(event: TimelineEvent) => void>();

  constructor(
    private readonly uow: UnitOfWork,
    options: DurableEventJournalOptions = {},
  ) {
    this.events = new EventRepository(uow, options);
  }

  /** 在一个立即事务中执行回调；提交后才发布收集到的事件。 */
  commit<T>(
    fn: (tx: SqliteTransaction, append: AppendEvent) => T,
  ): { value: T; events: TimelineEvent[] } {
    const events: TimelineEvent[] = [];
    const value = this.uow.immediate((tx) => {
      const append: AppendEvent = (input) => {
        const event = this.events.appendWithin(tx, input);
        events.push(event);
        return event;
      };
      return fn(tx, append);
    });
    this.publishCommitted(events);
    return { value, events };
  }

  /** 供命令执行器复用当前事务；不主动发布。 */
  for(tx: SqliteTransaction): AppendEvent {
    return (input) => this.events.appendWithin(tx, input);
  }

  appendWithin(
    tx: SqliteTransaction,
    input: EventAppendInput,
  ): TimelineEvent {
    return this.events.appendWithin(tx, input);
  }

  /** commit 之后调用；单个订阅者失败不影响其他订阅者或已提交事实。 */
  publishCommitted(events: readonly TimelineEvent[]): void {
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // 连接级发送失败留给 afterSeq 补拉。
        }
      }
    }
  }

  recent(sessionId: string, limit: number): TimelineEvent[] {
    return this.events.recent(sessionId, limit);
  }

  afterSeq(
    sessionId: string,
    afterSeq: number,
    limit: number,
  ): TimelineEvent[] {
    return this.events.afterSeq(sessionId, afterSeq, limit);
  }

  lastSeq(sessionId: string): number {
    return this.events.lastSeq(sessionId);
  }

  subscribe(listener: (event: TimelineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}