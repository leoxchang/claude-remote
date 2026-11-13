import { AgentError } from '../command/errors.js';
import { CommandIdentity } from '../command/canonical-request.js';
import { TimelineEvent } from '../events/adapter-events.js';
import { DurableEventJournal } from '../events/durable-event-journal.js';
import {
  CommandExecution,
  PersistentCommandExecutor,
} from '../storage/persistent-command-executor.js';
import { RunRepository } from '../storage/repositories/run-repository.js';
import { SessionRepository } from '../storage/repositories/session-repository.js';
import { SqliteTransaction } from '../storage/unit-of-work.js';
import {
  SnapshotManifest,
  SnapshotService,
} from './snapshot-service.js';

/** 单页限制：条数与字节。 */
export const MAX_SYNC_LIMIT = 100;
export const SYNC_PAGE_PAYLOAD_BYTES = 48 * 1024;
export const SYNC_MESSAGE_BYTES = 64 * 1024;
export const MAX_SYNC_GAP = 1000;

export interface SessionVolatileSummary {
  activeRunId: string | null;
  activeStatus: string | null;
  pendingApprovalCount: number;
  outcomeUnknown: boolean;
  eventTailMayBeIncomplete: boolean;
}

export interface SyncPage {
  events: TimelineEvent[];
  nextAfterSeq: number;
  lastSeq: number;
  hasMore: boolean;
  volatile: SessionVolatileSummary | null;
}

export interface ResyncRequired {
  resyncRequired: true;
  manifest: SnapshotManifest;
}

export type SyncOutcome = SyncPage | ResyncRequired;

export interface SessionSyncServiceDeps {
  executor: PersistentCommandExecutor;
  journal: DurableEventJournal;
  snapshots: SnapshotService;
  sessions: SessionRepository;
  runs: RunRepository;
}

/**
 * afterSeq 一致读同步。
 *
 * 在事务内捕获 L/F 与易失状态；缺口、越界或长离线返回 RESYNC_REQUIRED
 * 并同事务创建不可变快照。
 */
export class SessionSyncService {
  constructor(private readonly deps: SessionSyncServiceDeps) {}

  sync(input: {
    identity: CommandIdentity;
    actor: { deviceId: string };
    sessionId: string;
    afterSeq: number;
    limit: number;
    now: number;
  }): CommandExecution<SyncOutcome> {
    if (
      !Number.isInteger(input.afterSeq) ||
      input.afterSeq < 0 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_SYNC_LIMIT
    ) {
      throw new AgentError('INVALID_MESSAGE');
    }
    return this.deps.executor.execute<SyncOutcome>({
      identity: input.identity,
      actor: { kind: 'device', deviceId: input.actor.deviceId },
      kind: 'read_only',
      now: input.now,
      business: (tx) => {
        const session = this.deps.sessions.get(input.sessionId);
        if (session === undefined) throw new AgentError('SESSION_NOT_FOUND');
        const lastSeq = session.lastSeq;
        const floor = session.retentionFloor;
        if (
          input.afterSeq > lastSeq ||
          input.afterSeq < floor ||
          lastSeq - input.afterSeq > MAX_SYNC_GAP
        ) {
          const manifest = this.deps.snapshots.createWithin(tx, {
            sessionId: input.sessionId,
            reason: 'sync',
          });
          return { resyncRequired: true, manifest };
        }
        const events = this.pageWithin(
          tx,
          input.sessionId,
          input.afterSeq,
          input.limit,
        );
        const nextAfterSeq =
          events.length === 0
            ? input.afterSeq
            : (events[events.length - 1]?.seq ?? input.afterSeq);
        const hasMore = nextAfterSeq < lastSeq;
        return {
          events,
          nextAfterSeq,
          lastSeq,
          hasMore,
          volatile: hasMore ? null : this.volatileSummary(input.sessionId),
        };
      },
    });
  }

  private pageWithin(
    tx: SqliteTransaction,
    sessionId: string,
    afterSeq: number,
    limit: number,
  ): TimelineEvent[] {
    const rows = tx
      .prepare(
        `SELECT eventId, sessionId, seq, runId, approvalId, type, payloadJson, timestamp
         FROM events WHERE sessionId = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit) as Array<{
      eventId: string;
      sessionId: string;
      seq: number;
      runId: string | null;
      approvalId: string | null;
      type: string;
      payloadJson: string;
      timestamp: number;
    }>;
    const events: TimelineEvent[] = [];
    let bytes = 0;
    for (const row of rows) {
      const event: TimelineEvent = {
        protocolVersion: 1,
        messageId: `msg_${row.eventId}`,
        timestamp: row.timestamp,
        type: row.type,
        payload: JSON.parse(row.payloadJson) as Record<string, never>,
        eventId: row.eventId,
        sessionId: row.sessionId,
        seq: row.seq,
        ...(row.runId === null ? {} : { runId: row.runId }),
        ...(row.approvalId === null ? {} : { approvalId: row.approvalId }),
      };
      const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (bytes + size > SYNC_PAGE_PAYLOAD_BYTES) break;
      bytes += size;
      events.push(event);
    }
    const total = Buffer.byteLength(JSON.stringify(events), 'utf8');
    return total > SYNC_MESSAGE_BYTES ? events.slice(0, 1) : events;
  }

  private volatileSummary(sessionId: string): SessionVolatileSummary {
    const statuses = ['waiting_approval', 'running', 'starting', 'cancelling'];
    for (const status of statuses) {
      const active = this.deps.runs
        .listByStatus(status)
        .find((run) => run.sessionId === sessionId);
      if (active !== undefined) {
        return {
          activeRunId: active.runId,
          activeStatus: active.status,
          pendingApprovalCount: active.pendingApprovalCount,
          outcomeUnknown: active.outcomeUnknown,
          eventTailMayBeIncomplete: active.eventTailMayBeIncomplete,
        };
      }
    }
    return {
      activeRunId: null,
      activeStatus: null,
      pendingApprovalCount: 0,
      outcomeUnknown: false,
      eventTailMayBeIncomplete: false,
    };
  }
}