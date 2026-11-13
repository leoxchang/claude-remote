import { ProtocolConflictError } from '@claude-remote/protocol/timeline';

import { AgentError } from '../../command/errors.js';
import { JsonObject } from '../../domain/types.js';
import { TimelineEvent } from '../../events/adapter-events.js';
import { randomBase64Url } from '../../security/random.js';
import { SqliteTransaction, UnitOfWork } from '../unit-of-work.js';

const EVENT_ID_BYTES = 9;

export interface EventAppendInput {
  sessionId: string;
  type: string;
  payload: JsonObject;
  eventId?: string;
  runId?: string;
  approvalId?: string;
}

interface EventRow {
  eventId: string;
  sessionId: string;
  seq: number;
  runId: string | null;
  approvalId: string | null;
  type: string;
  payloadJson: string;
  timestamp: number;
}

/** events 表读写；只保存有界规范化事件，不复制原始 SDK message。 */
export class EventRepository {
  private readonly now: () => number;
  private readonly generateEventId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    options: {
      now?: () => number;
      generateEventId?: () => string;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.generateEventId =
      options.generateEventId ??
      (() => `event_${randomBase64Url(EVENT_ID_BYTES)}`);
  }

  /** 在当前事务内分配 seq、插入事件并推进 sessions.lastSeq。 */
  appendWithin(tx: SqliteTransaction, input: EventAppendInput): TimelineEvent {
    const eventId = input.eventId ?? this.generateEventId();
    const existing = this.byId(tx, eventId);
    if (existing !== undefined) {
      const sameContent =
        existing.sessionId === input.sessionId &&
        existing.type === input.type &&
        existing.payloadJson === JSON.stringify(input.payload);
      if (!sameContent) {
        throw new ProtocolConflictError('event id reused with different content');
      }
      return toEvent(existing);
    }

    const session = tx
      .prepare('SELECT lastSeq FROM sessions WHERE sessionId = ?')
      .get(input.sessionId) as { lastSeq: number } | undefined;
    if (session === undefined) throw new AgentError('SESSION_NOT_FOUND');

    const seq = session.lastSeq + 1;
    const timestamp = this.now();
    const payloadJson = JSON.stringify(input.payload);
    tx.prepare(
      `INSERT INTO events
         (eventId, sessionId, seq, runId, approvalId, type, payloadJson, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      input.sessionId,
      seq,
      input.runId ?? null,
      input.approvalId ?? null,
      input.type,
      payloadJson,
      timestamp,
    );
    tx.prepare('UPDATE sessions SET lastSeq = ? WHERE sessionId = ?').run(
      seq,
      input.sessionId,
    );
    return {
      protocolVersion: 1,
      messageId: `msg_${eventId}`,
      timestamp,
      type: input.type,
      payload: input.payload,
      eventId,
      sessionId: input.sessionId,
      seq,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.approvalId === undefined
        ? {}
        : { approvalId: input.approvalId }),
    };
  }

  recent(sessionId: string, limit: number): TimelineEvent[] {
    return this.read((tx) => {
      const rows = tx
        .prepare(
          `SELECT eventId, sessionId, seq, runId, approvalId, type, payloadJson, timestamp
           FROM events WHERE sessionId = ? ORDER BY seq DESC LIMIT ?`,
        )
        .all(sessionId, Math.max(0, limit)) as EventRow[];
      return rows.reverse().map(toEvent);
    });
  }

  afterSeq(
    sessionId: string,
    afterSeq: number,
    limit: number,
  ): TimelineEvent[] {
    return this.read((tx) => {
      const rows = tx
        .prepare(
          `SELECT eventId, sessionId, seq, runId, approvalId, type, payloadJson, timestamp
           FROM events WHERE sessionId = ? AND seq > ? ORDER BY seq LIMIT ?`,
        )
        .all(sessionId, afterSeq, Math.max(0, limit)) as EventRow[];
      return rows.map(toEvent);
    });
  }

  lastSeq(sessionId: string): number {
    return this.read((tx) => {
      const row = tx
        .prepare('SELECT lastSeq FROM sessions WHERE sessionId = ?')
        .get(sessionId) as { lastSeq: number } | undefined;
      return row?.lastSeq ?? 0;
    });
  }

  private byId(
    tx: SqliteTransaction,
    eventId: string,
  ): EventRow | undefined {
    return tx
      .prepare(
        `SELECT eventId, sessionId, seq, runId, approvalId, type, payloadJson, timestamp
         FROM events WHERE eventId = ?`,
      )
      .get(eventId) as EventRow | undefined;
  }

  private read<T>(fn: (tx: SqliteTransaction) => T): T {
    return fn(this.uow.connectionRef);
  }
}

function toEvent(row: EventRow): TimelineEvent {
  return {
    protocolVersion: 1,
    messageId: `msg_${row.eventId}`,
    timestamp: row.timestamp,
    type: row.type,
    payload: JSON.parse(row.payloadJson) as JsonObject,
    eventId: row.eventId,
    sessionId: row.sessionId,
    seq: row.seq,
    ...(row.runId === null ? {} : { runId: row.runId }),
    ...(row.approvalId === null ? {} : { approvalId: row.approvalId }),
  };
}