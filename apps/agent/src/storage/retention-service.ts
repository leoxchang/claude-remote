import { DurableEventJournal } from '../events/durable-event-journal.js';
import { CommandRepository } from './repositories/command-repository.js';
import { RunRepository } from './repositories/run-repository.js';
import { SessionRepository } from './repositories/session-repository.js';
import { SnapshotService } from '../sync/snapshot-service.js';
import { StorageHealth } from './storage-health.js';
import { SqliteTransaction, UnitOfWork } from './unit-of-work.js';

const DAY = 24 * 60 * 60 * 1000;

export const EVENT_RETENTION_MS = 30 * DAY;
export const EVENT_RETENTION_COUNT = 5_000;
export const PROMPT_RETENTION_MS = 30 * DAY;
export const APPROVAL_RETENTION_MS = 90 * DAY;
export const SNAPSHOT_RETENTION_MS = 30 * DAY;
export const MAX_SNAPSHOTS_PER_SESSION = 2;
export const RETENTION_EVENT_BATCH = 500;
export const SOFT_LIMIT_BYTES = 512 * 1024 * 1024;
export const TARGET_LIMIT_BYTES = 448 * 1024 * 1024;

export interface RetentionLimits {
  eventRetentionMs: number;
  eventRetentionCount: number;
  promptRetentionMs: number;
  approvalRetentionMs: number;
  snapshotRetentionMs: number;
  maxSnapshotsPerSession: number;
  eventBatch: number;
  softLimitBytes: number;
  targetLimitBytes: number;
}

export interface RetentionReport {
  deletedEvents: number;
  expiredPrompts: number;
  expiredCommands: number;
  deletedApprovals: number;
  deletedSnapshots: number;
  liveBytes: number;
  state: 'ok' | 'limited' | 'unavailable';
}

export interface RetentionServiceDeps {
  uow: UnitOfWork;
  journal: DurableEventJournal;
  runs: RunRepository;
  sessions: SessionRepository;
  commands: CommandRepository;
  snapshots: SnapshotService;
  health: StorageHealth;
  limits?: Partial<RetentionLimits>;
  now?: () => number;
}

/**
 * 有界清理：只删连续最旧前缀与过期只读结果；副作用幂等记录永不删除。
 *
 * 首次删除前生成 retention 快照；清理后仍超 soft limit 时降级为 limited。
 */
export class RetentionService {
  private readonly limits: RetentionLimits;
  private readonly now: () => number;

  constructor(private readonly deps: RetentionServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.limits = {
      eventRetentionMs: EVENT_RETENTION_MS,
      eventRetentionCount: EVENT_RETENTION_COUNT,
      promptRetentionMs: PROMPT_RETENTION_MS,
      approvalRetentionMs: APPROVAL_RETENTION_MS,
      snapshotRetentionMs: SNAPSHOT_RETENTION_MS,
      maxSnapshotsPerSession: MAX_SNAPSHOTS_PER_SESSION,
      eventBatch: RETENTION_EVENT_BATCH,
      softLimitBytes: SOFT_LIMIT_BYTES,
      targetLimitBytes: TARGET_LIMIT_BYTES,
      ...deps.limits,
    };
  }

  runOnce(now: number = this.now()): RetentionReport {
    const report: RetentionReport = {
      deletedEvents: 0,
      expiredPrompts: 0,
      expiredCommands: 0,
      deletedApprovals: 0,
      deletedSnapshots: 0,
      liveBytes: 0,
      state: 'ok',
    };
    this.deps.uow.immediate((tx) => {
      report.expiredPrompts += this.expirePrompts(tx, now);
      report.deletedEvents += this.trimEvents(tx, now);
      report.deletedSnapshots += this.trimSnapshots(tx, now);
      report.deletedApprovals += this.trimApprovals(tx, now);
      report.expiredCommands = this.deps.commands.expireReadOnlyResultsWithin(
        tx,
        now,
      );
    });
    report.liveBytes = this.deps.health.current().liveBytes;
    return report;
  }

  /** 容量检查：清理到 target；仍超 soft 时 limited。 */
  evaluateCapacity(liveBytes: number): 'ok' | 'limited' {
    this.deps.health.reportLiveBytes(liveBytes);
    if (liveBytes > this.limits.softLimitBytes) {
      this.deps.health.degraded('limited');
      return 'limited';
    }
    if (liveBytes > this.limits.targetLimitBytes) {
      return 'ok';
    }
    return 'ok';
  }

  private expirePrompts(tx: SqliteTransaction, now: number): number {
    let expired = 0;
    const runs = this.deps.runs
      .listByStatus('queued')
      .concat(this.deps.runs.listByStatus('recovery_required'))
      .concat(this.deps.runs.listByStatus('starting'))
      .concat(this.deps.runs.listByStatus('running'))
      .concat(this.deps.runs.listByStatus('waiting_approval'))
      .concat(this.deps.runs.listByStatus('cancelling'));
    for (const run of runs) {
      if (run.promptText === null || run.promptExpiresAt === null) continue;
      if (run.promptExpiresAt > now) continue;
      if (run.status === 'queued' || run.status === 'recovery_required') {
        this.deps.runs.update({
          ...run,
          status: 'cancelled',
          promptText: null,
          endedAt: now,
          errorSummary: 'retention_expired',
        });
        this.deps.journal.appendWithin(tx, {
          sessionId: run.sessionId,
          type: 'run.completed',
          runId: run.runId,
          payload: { status: 'cancelled', reason: 'retention_expired' },
        });
        expired += 1;
      } else {
        this.deps.runs.update({ ...run, promptText: null });
      }
    }
    return expired;
  }

  private trimEvents(tx: SqliteTransaction, now: number): number {
    let deleted = 0;
    const cutoff = now - this.limits.eventRetentionMs;
    for (const session of this.deps.sessions.listAll()) {
      const rows = this.deps.uow.connectionRef
        .prepare(
          'SELECT seq, timestamp FROM events WHERE sessionId = ? ORDER BY seq ASC',
        )
        .all(session.sessionId) as Array<{ seq: number; timestamp: number }>;
      if (rows.length === 0) continue;
      const oldCount = rows.filter((row) => row.timestamp < cutoff).length;
      const excess = Math.max(0, rows.length - this.limits.eventRetentionCount);
      const cutIndex = Math.max(oldCount, excess);
      if (cutIndex <= 0) continue;
      const lastDeleted = rows[cutIndex - 1];
      if (lastDeleted === undefined) continue;
      const floor = session.retentionFloor;
      const upTo = Math.min(
        lastDeleted.seq,
        floor + this.limits.eventBatch,
      );
      if (upTo <= floor) continue;
      this.deps.snapshots.createWithin(tx, {
        sessionId: session.sessionId,
        reason: 'retention',
      });
      tx.prepare(
        'DELETE FROM events WHERE sessionId = ? AND seq <= ?',
      ).run(session.sessionId, upTo);
      this.deps.sessions.updateRetentionFloor(session.sessionId, upTo);
      deleted += upTo - floor;
    }
    return deleted;
  }

  private trimSnapshots(tx: SqliteTransaction, now: number): number {
    let deleted = 0;
    const cutoff = now - this.limits.snapshotRetentionMs;
    const rows = this.deps.uow.connectionRef
      .prepare(
        'SELECT snapshotId, sessionId, createdAt FROM snapshots ORDER BY sessionId, createdAt DESC',
      )
      .all() as Array<{ snapshotId: string; sessionId: string; createdAt: number }>;
    const perSession = new Map<string, number>();
    for (const row of rows) {
      const index = perSession.get(row.sessionId) ?? 0;
      perSession.set(row.sessionId, index + 1);
      const tooOld = row.createdAt < cutoff;
      const tooMany = index >= this.limits.maxSnapshotsPerSession;
      if (!tooOld && !tooMany) continue;
      tx.prepare('DELETE FROM snapshots WHERE snapshotId = ?').run(
        row.snapshotId,
      );
      deleted += 1;
    }
    return deleted;
  }

  private trimApprovals(tx: SqliteTransaction, now: number): number {
    const cutoff = now - this.limits.approvalRetentionMs;
    {
      const approvals = tx
        .prepare(
          "DELETE FROM approvals WHERE status != 'pending' AND resolvedAt IS NOT NULL AND resolvedAt < ?",
        )
        .run(cutoff);
      tx.prepare('DELETE FROM audit_logs WHERE createdAt < ?').run(cutoff);
      return approvals.changes;
    }
  }

}
