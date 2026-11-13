import { TimelineEvent } from './adapter-events.js';
import { DurableEventJournal } from './durable-event-journal.js';
import { EventAppendPort } from './normalizer.js';
import { JournalAppendInput } from './journal.js';

/**
 * 把持久 journal 暴露为 Normalizer/Connection 需要的同步 append 端口。
 *
 * 每条普通事件独立提交；命令业务事件仍由 PersistentCommandExecutor
 * 在同一事务内写入，避免双写。
 */
export class DurableJournalAdapter implements EventAppendPort {
  constructor(private readonly journal: DurableEventJournal) {}

  append(input: JournalAppendInput): TimelineEvent {
    return this.journal.commit((_tx, append) => append(input)).value;
  }

  recent(sessionId: string, limit: number): TimelineEvent[] {
    return this.journal.recent(sessionId, limit);
  }

  afterSeq(sessionId: string, afterSeq: number, limit: number): TimelineEvent[] {
    return this.journal.afterSeq(sessionId, afterSeq, limit);
  }

  lastSeq(sessionId: string): number {
    return this.journal.lastSeq(sessionId);
  }

  subscribe(listener: (event: TimelineEvent) => void): () => void {
    return this.journal.subscribe(listener);
  }
}