import { createHash } from 'node:crypto';

import { CommandIdentity } from '../command/canonical-request.js';
import { AgentError } from '../command/errors.js';
import { TimelineEvent } from '../events/adapter-events.js';
import { DurableEventJournal } from '../events/durable-event-journal.js';
import { approvalContentDescriptor } from '../approval/approval-content.js';
import { toApprovalSummary } from '../approval/approval-summary.js';
import { DurableApprovalStore } from '../approval/durable-approval-store.js';
import {
  CommandExecution,
  PersistentCommandExecutor,
} from '../storage/persistent-command-executor.js';
import { RunRepository } from '../storage/repositories/run-repository.js';
import { SessionRepository } from '../storage/repositories/session-repository.js';
import { randomBase64Url } from '../security/random.js';
import { MAX_ACTIVE_RUNS } from '../run/run-limits.js';
import { SqliteTransaction, UnitOfWork } from '../storage/unit-of-work.js';

/** 快照最大页数与单页/单消息字节上限。 */
export const MAX_SNAPSHOT_PAGES = 8;
export const SNAPSHOT_PAGE_PAYLOAD_BYTES = 48 * 1024;
export const SNAPSHOT_TOTAL_MESSAGE_BYTES = 64 * 1024;
export const MAX_RECENT_EVENTS = 500;

export interface SnapshotManifest {
  snapshotId: string;
  sessionId: string;
  lastSeq: number;
  pageCount: number;
  byteLength: number;
  sha256: string;
}

export interface SnapshotPageResult extends SnapshotManifest {
  pageIndex: number;
  payload: Record<string, unknown>;
}

export interface SnapshotServiceDeps {
  executor: PersistentCommandExecutor;
  journal: DurableEventJournal;
  sessions: SessionRepository;
  runs: RunRepository;
  approvals: DurableApprovalStore;
  uow: UnitOfWork;
  now?: () => number;
}

/**
 * 不可变分页快照。
 *
 * createWithin 只写 DB；getPage 是 read-only 命令，重复 commandId 返回同一页。
 */
export class SnapshotService {
  private readonly now: () => number;

  constructor(private readonly deps: SnapshotServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  getPage(input: {
    identity: CommandIdentity;
    actor: { deviceId: string };
    sessionId: string;
    snapshotId?: string;
    pageIndex?: number;
    now: number;
  }): CommandExecution<SnapshotPageResult> {
    return this.deps.executor.execute<SnapshotPageResult>({
      identity: input.identity,
      actor: { kind: 'device', deviceId: input.actor.deviceId },
      kind: 'read_only',
      now: input.now,
      business: (tx) => {
        const session = this.deps.sessions.get(input.sessionId);
        if (session === undefined) throw new AgentError('SESSION_NOT_FOUND');
        const manifest =
          input.snapshotId === undefined
            ? this.createWithin(tx, {
                sessionId: input.sessionId,
                reason: 'sync',
              })
            : this.manifest(tx, input.snapshotId, input.sessionId);
        if (manifest === null) throw new AgentError('SNAPSHOT_NOT_FOUND');
        const pageIndex = input.pageIndex ?? 0;
        if (pageIndex < 0 || pageIndex >= manifest.pageCount) {
          throw new AgentError('SNAPSHOT_NOT_FOUND');
        }
        const row = tx
          .prepare(
            'SELECT payloadJson FROM snapshot_pages WHERE snapshotId = ? AND pageIndex = ?',
          )
          .get(manifest.snapshotId, pageIndex) as
          | { payloadJson: string }
          | undefined;
        if (row === undefined) throw new AgentError('SNAPSHOT_NOT_FOUND');
        return {
          ...manifest,
          pageIndex,
          payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
        };
      },
    });
  }

  /** 在调用方事务内创建 manifest 与页；不开启嵌套事务。 */
  createWithin(
    tx: SqliteTransaction,
    input: { sessionId: string; reason: 'sync' | 'retention' },
  ): SnapshotManifest {
    const session = this.deps.sessions.get(input.sessionId);
    if (session === undefined) throw new AgentError('SESSION_NOT_FOUND');
    const lastSeq = session.lastSeq;
    const events = this.deps.journal.recent(input.sessionId, MAX_RECENT_EVENTS);
    const pages = this.buildPages(
      input.sessionId,
      lastSeq,
      events,
      input.reason,
    );
    const snapshotId = `snap_${randomBase64Url(9)}`;
    const canonical = canonicalJson(pages);
    const byteLength = Buffer.byteLength(canonical, 'utf8');
    const sha256 = createHash('sha256').update(canonical, 'utf8').digest('hex');
    tx.prepare(
      `INSERT INTO snapshots
         (snapshotId, sessionId, lastSeq, pageCount, byteLength, sha256, reason, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      snapshotId,
      input.sessionId,
      lastSeq,
      pages.length,
      byteLength,
      sha256,
      input.reason,
      this.now(),
    );
    const insertPage = tx.prepare(
      'INSERT INTO snapshot_pages (snapshotId, pageIndex, payloadJson) VALUES (?, ?, ?)',
    );
    pages.forEach((page, pageIndex) => {
      insertPage.run(snapshotId, pageIndex, JSON.stringify(page));
    });
    return {
      snapshotId,
      sessionId: input.sessionId,
      lastSeq,
      pageCount: pages.length,
      byteLength,
      sha256,
    };
  }

  private buildPages(
    sessionId: string,
    lastSeq: number,
    events: TimelineEvent[],
    reason: 'sync' | 'retention',
  ): Array<Record<string, unknown>> {
    const session = this.deps.sessions.get(sessionId);
    if (session === undefined) throw new AgentError('SESSION_NOT_FOUND');
    const active = this.activeRun(sessionId);
    const queued = this.deps.runs
      .listByStatus('queued')
      .filter((run) => run.sessionId === sessionId)
      .slice(0, 20)
      .map((run) => ({
        runId: run.runId,
        commandId: run.commandId,
        status: 'queued',
        enqueuedAt: run.enqueuedAt,
        recoveryGeneration: run.recoveryGeneration,
      }));
    const recovery = this.deps.runs
      .listByStatus('recovery_required')
      .filter((run) => run.sessionId === sessionId)
      .map((run) => ({
        runId: run.runId,
        commandId: run.commandId,
        recoveryGeneration: run.recoveryGeneration,
        enqueuedAt: run.enqueuedAt,
        promptExpiresAt: run.promptExpiresAt,
      }));
    const pending = this.deps.approvals
      .pendingForSession(sessionId)
      .flatMap((record) =>
        record.content === null
          ? []
          : [
              toApprovalSummary(
                record,
                approvalContentDescriptor(record.content),
              ),
            ],
      );
    const globalActive = this.deps.runs.listByStatus('starting').length +
      this.deps.runs.listByStatus('running').length +
      this.deps.runs.listByStatus('waiting_approval').length +
      this.deps.runs.listByStatus('cancelling').length;

    const pages: Array<Record<string, unknown>> = [];
    let cursor = 0;
    for (let pageIndex = 0; pageIndex < MAX_SNAPSHOT_PAGES; pageIndex += 1) {
      const page: Record<string, unknown> = {
        lastSeq,
        recentEvents: [] as TimelineEvent[],
      };
      if (pageIndex === 0) {
        Object.assign(page, {
          session: {
            sessionId: session.sessionId,
            workspaceId: session.workspaceId,
            claudeSessionId: session.claudeSessionId,
            title: session.title,
            status: session.status,
          },
          activeRun:
            active === undefined
              ? null
              : {
                  runId: active.runId,
                  status: active.status,
                  pendingApprovalCount: active.pendingApprovalCount,
                  recoveryGeneration: active.recoveryGeneration,
                  outcomeUnknown: active.outcomeUnknown,
                  eventTailMayBeIncomplete: active.eventTailMayBeIncomplete,
                },
          queuedRuns: queued,
          recoveryRequiredRuns: recovery,
          pendingApprovals: pending,
          globalCapacity: {
            activeRunCount: globalActive,
            maxActiveRuns: MAX_ACTIVE_RUNS,
          },
          snapshotTruncated: false,
        });
      }
      const bucket: TimelineEvent[] = [];
      while (cursor < events.length) {
        const candidate = events[cursor];
        if (candidate === undefined) break;
        const nextPage = { ...page, recentEvents: [...bucket, candidate] };
        if (
          Buffer.byteLength(JSON.stringify(nextPage), 'utf8') >
          SNAPSHOT_PAGE_PAYLOAD_BYTES
        ) {
          break;
        }
        bucket.push(candidate);
        cursor += 1;
      }
      page['recentEvents'] = bucket;
      pages.push(page);
      if (cursor >= events.length) break;
      if (pageIndex === MAX_SNAPSHOT_PAGES - 1) {
        // 页数已达上限：丢弃最旧事件，保证状态页完整。
        page['snapshotTruncated'] = true;
        break;
      }
    }
    if (reason === 'retention' && pages[0] !== undefined) {
      pages[0]['snapshotTruncated'] = true;
    }
    return pages;
  }

  private manifest(
    tx: SqliteTransaction,
    snapshotId: string,
    sessionId: string,
  ): SnapshotManifest | null {
    const row = tx
      .prepare(
        `SELECT snapshotId, sessionId, lastSeq, pageCount, byteLength, sha256
         FROM snapshots WHERE snapshotId = ? AND sessionId = ?`,
      )
      .get(snapshotId, sessionId) as SnapshotManifest | undefined;
    return row ?? null;
  }

  private activeRun(sessionId: string) {
    const statuses = ['starting', 'running', 'waiting_approval', 'cancelling'];
    for (const status of statuses) {
      const found = this.deps.runs
        .listByStatus(status)
        .find((run) => run.sessionId === sessionId);
      if (found !== undefined) return found;
    }
    return undefined;
  }
}

function sha256Canonical(pages: unknown[]): string {
  return createHash('sha256')
    .update(canonicalJson(pages), 'utf8')
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}