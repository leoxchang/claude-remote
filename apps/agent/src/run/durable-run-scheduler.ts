import { AdapterRegistry } from '../adapter/adapter-registry.js';
import {
  ManagedRunDriver,
  ManagedRunHandle,
  PermissionGate,
} from '../adapter/managed-run-driver.js';
import { AgentError } from '../command/errors.js';
import { assertWorkspacePathCurrent } from '../config/workspace-path.js';
import { DurableEventJournal } from '../events/durable-event-journal.js';
import { AdapterEvent } from '../events/adapter-events.js';
import { WorkspaceRecord } from '../workspace/workspace-types.js';
import { MAX_ACTIVE_RUNS } from './run-limits.js';
import { RunRepository, StoredRun } from '../storage/repositories/run-repository.js';
import {
  SessionRepository,
  StoredSession,
} from '../storage/repositories/session-repository.js';
import { WorkspaceRepository } from '../storage/repositories/workspace-repository.js';
import { SqliteTransaction, UnitOfWork } from '../storage/unit-of-work.js';

/** 占用执行槽的权威状态。 */
export const ACTIVE_STATUSES: readonly string[] = [
  'starting',
  'running',
  'waiting_approval',
  'cancelling',
];

/** 开始执行所需的全部已提交状态。 */
export interface RunStartContext {
  run: StoredRun;
  session: StoredSession;
  workspace: WorkspaceRecord;
  generation: number;
}

export interface DurableCancelDecision {
  outcome: 'started' | 'alreadyCancelling';
  run: StoredRun;
  handle: ManagedRunHandle | null;
}

export interface DurableRunSchedulerDeps {
  uow: UnitOfWork;
  sessions: SessionRepository;
  runs: RunRepository;
  workspaces: WorkspaceRepository;
  journal: DurableEventJournal;
  driver: ManagedRunDriver;
  registry?: AdapterRegistry;
  permissionGate?: PermissionGate;
  now?: () => number;
}

const UNAVAILABLE_PERMISSION_GATE: PermissionGate = {
  request: (_runId, request) =>
    Promise.resolve({
      behavior: 'deny',
      message: 'Mobile approval is not available',
      interrupt: false,
      toolUseID: request.toolUseID,
    }),
};

/**
 * 以 SQLite 投影为权威的调度器。
 *
 * beginStart 先把 queued→starting 提交，之后才创建 SDK query；
 * 任何 DB 写失败进入 degraded，停止新的 start。
 */
export class DurableRunScheduler {
  private readonly uow: UnitOfWork;
  private readonly sessions: SessionRepository;
  private readonly runs: RunRepository;
  private readonly workspaces: WorkspaceRepository;
  private readonly journal: DurableEventJournal;
  private readonly driver: ManagedRunDriver;
  private readonly registry: AdapterRegistry;
  private permissionGate: PermissionGate;
  private readonly now: () => number;
  private generation = 0;
  private degraded = false;
  private eventHandler:
    | ((event: AdapterEvent, context: { runId: string; generation: number }) => void)
    | null = null;

  constructor(options: DurableRunSchedulerDeps) {
    this.uow = options.uow;
    this.sessions = options.sessions;
    this.runs = options.runs;
    this.workspaces = options.workspaces;
    this.journal = options.journal;
    this.driver = options.driver;
    this.registry = options.registry ?? new AdapterRegistry();
    this.permissionGate =
      options.permissionGate ?? UNAVAILABLE_PERMISSION_GATE;
    this.now = options.now ?? Date.now;
  }

  setEventHandler(
    handler: (event: AdapterEvent, context: { runId: string; generation: number }) => void,
  ): void {
    this.eventHandler = handler;
  }

  setPermissionGate(gate: PermissionGate): void {
    this.permissionGate = gate;
  }

  isCurrent(runId: string, generation: number): boolean {
    return this.registry.assertCurrent(runId, generation);
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  /** 启动后由 Admission commit 回调触发；只调度 queued。 */
  drain(): void {
    if (this.degraded) return;
    while (this.activeCount() < MAX_ACTIVE_RUNS) {
      const candidate = this.nextQueued();
      if (candidate === undefined) return;
      const started = this.startOne(candidate.runId);
      if (started === 'stop') return;
    }
  }

  /** queued→starting，并在同一事务内复核到期、路径与槽位。 */
  beginStart(runId: string, now: number): RunStartContext | 'expired' | null {
    return this.uow.immediate((tx) => {
      const run = this.runs.get(runId);
      if (run === undefined || run.status !== 'queued') return null;
      if (
        run.promptText === null ||
        (run.promptExpiresAt !== null && run.promptExpiresAt <= now)
      ) {
        this.terminateWithin(tx, run, 'cancelled', 'retention_expired');
        return 'expired';
      }
      const session = this.sessions.get(run.sessionId);
      if (session === undefined || session.lifecycle !== 'active') {
        this.terminateWithin(tx, run, 'failed', 'SESSION_ARCHIVED');
        return 'expired';
      }
      const workspace = this.workspaces.get(run.workspaceId);
      if (workspace === undefined) {
        this.terminateWithin(tx, run, 'failed', 'WORKSPACE_NOT_ALLOWED');
        return 'expired';
      }
      try {
        assertWorkspacePathCurrent(workspace);
      } catch {
        this.terminateWithin(tx, run, 'failed', 'WORKSPACE_NOT_ALLOWED');
        return 'expired';
      }
      if (this.activeCountWithin(run.sessionId) > 0) return null;
      if (this.activeCount() >= MAX_ACTIVE_RUNS) return null;
      const generation = ++this.generation;
      const starting: StoredRun = {
        ...run,
        status: 'starting',
        startedAt: now,
      };
      this.runs.update(starting);
      return { run: starting, session, workspace, generation };
    });
  }

  /** 记录 handle 已注册并写入 run.started；失败时关闭 handle。 */
  markStarted(runId: string, generation: number): void {
    try {
      this.uow.immediate((tx) => {
        if (!this.registry.assertCurrent(runId, generation)) {
          throw new AgentError('RUN_NOT_ACTIVE');
        }
        const run = this.runs.get(runId);
        if (run === undefined || run.status !== 'starting') {
          throw new AgentError('RUN_NOT_ACTIVE');
        }
        this.journal.appendWithin(tx, {
          sessionId: run.sessionId,
          type: 'run.started',
          payload: { startedAt: run.startedAt ?? this.now(), status: 'starting' },
          runId,
        });
      });
    } catch (error: unknown) {
      this.degraded = true;
      void this.closeHandle(runId);
      throw error;
    }
  }

  /** SDK init 或首批事件到达：starting→running。 */
  markRunning(runId: string): void {
    this.uow.immediate((tx) => {
      const run = this.runs.get(runId);
      if (run === undefined) return;
      if (run.status !== 'starting' && run.status !== 'waiting_approval') {
        return;
      }
      const running: StoredRun = { ...run, status: 'running' };
      this.runs.update(running);
      this.updateSessionStatus(run.sessionId, 'running');
      this.journal.appendWithin(tx, {
        sessionId: run.sessionId,
        type: 'session.status',
        payload: { state: 'running', status: 'running' },
        runId,
      });
    });
  }

  /** 更新 pending 审批数与等待状态。 */
  setPendingApprovalCount(runId: string, count: number): void {
    this.uow.immediate((tx) => {
      const run = this.runs.get(runId);
      if (run === undefined) return;
      const nextStatus =
        count > 0
          ? ['starting', 'running', 'waiting_approval'].includes(run.status)
            ? 'waiting_approval'
            : run.status
          : run.status === 'waiting_approval'
            ? 'running'
            : run.status;
      if (nextStatus === run.status && run.pendingApprovalCount === count) {
        return;
      }
      this.runs.update({
        ...run,
        status: nextStatus,
        pendingApprovalCount: count,
      });
      this.updateSessionStatus(
        run.sessionId,
        nextStatus === 'waiting_approval' ? 'waiting_approval' : 'running',
      );
      this.journal.appendWithin(tx, {
        sessionId: run.sessionId,
        type: 'session.status',
        payload: {
          state: nextStatus,
          status: nextStatus,
          pendingApprovalCount: count,
        },
        runId,
      });
    });
  }

  /** 取消只改 DB；调用方 commit 之后才 interrupt。 */
  beginCancel(runId: string): DurableCancelDecision {
    const decision = this.uow.immediate(() => {
      const run = this.runs.get(runId);
      if (run === undefined || !ACTIVE_STATUSES.includes(run.status)) {
        throw new AgentError(
          run === undefined ? 'RUN_NOT_FOUND' : 'RUN_NOT_ACTIVE',
        );
      }
      if (run.status === 'cancelling') {
        return { outcome: 'alreadyCancelling' as const, run };
      }
      const cancelling: StoredRun = { ...run, status: 'cancelling' };
      this.runs.update(cancelling);
      return { outcome: 'started' as const, run: cancelling };
    });
    return {
      outcome: decision.outcome,
      run: decision.run,
      handle: this.registry.get(runId),
    };
  }

  /** 终态写入、事件、释放槽位，再继续调度。 */
  complete(input: {
    runId: string;
    status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
    errorSummary?: string;
    outcomeUnknown?: boolean;
  }): void {
    this.uow.immediate((tx) => {
      const run = this.runs.get(input.runId);
      if (run === undefined) throw new AgentError('RUN_NOT_FOUND');
      if (isTerminal(run.status)) return;
      const terminal: StoredRun = {
        ...run,
        status: input.status,
        promptText: null,
        pendingApprovalCount: 0,
        endedAt: this.now(),
        errorSummary: input.errorSummary ?? null,
        outcomeUnknown: input.outcomeUnknown === true,
      };
      this.runs.update(terminal);
      this.updateSessionStatus(terminal.sessionId, 'idle');
      this.journal.appendWithin(tx, {
        sessionId: terminal.sessionId,
        type: 'run.completed',
        payload: {
          status: input.status,
          ...(input.errorSummary === undefined
            ? {}
            : {
                error: {
                  code: input.errorSummary,
                  message: input.errorSummary,
                },
              }),
        },
        runId: terminal.runId,
      });
    });
    this.releaseHandle(input.runId);
    this.drain();
  }

  /** 从排队的 run 中移除；recovery_required 由 Task 10 扩展。 */
  removeQueued(runId: string): {
    sessionId: string;
    runId: string;
    status: 'cancelled';
    removed: true;
  } {
    const result = this.uow.immediate((tx) => {
      const run = this.runs.get(runId);
      if (run === undefined) throw new AgentError('RUN_NOT_FOUND');
      if (run.status !== 'queued') throw new AgentError('RUN_NOT_QUEUED');
      this.terminateWithin(tx, run, 'cancelled', 'queue_removed');
      return { sessionId: run.sessionId, runId, status: 'cancelled' as const };
    });
    this.drain();
    return { ...result, removed: true };
  }

  async closeHandle(runId: string): Promise<void> {
    const handle = this.registry.get(runId);
    this.registry.remove(runId);
    if (handle === null) return;
    try {
      await handle.close();
    } catch {
      // 关闭失败只影响清理；终态仍以 DB 为准。
    }
  }

  /** 释放句柄但不再写终态（complete 后调用）。 */
  releaseHandle(runId: string): void {
    const handle = this.registry.get(runId);
    this.registry.remove(runId);
    if (handle === null) return;
    void handle.close().catch(() => undefined);
  }

  activeCount(): number {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const row = this.uow.connectionRef
      .prepare(`SELECT count(*) AS total FROM runs WHERE status IN (${placeholders})`)
      .get(...ACTIVE_STATUSES) as { total: number };
    return row.total;
  }

  queuedRunCount(): number {
    return this.runs.countByStatus('queued');
  }

  queuedRuns(sessionId: string): StoredRun[] {
    return this.runs.listByStatus('queued').filter(
      (run) => run.sessionId === sessionId,
    );
  }

  recoveryRequiredRuns(): StoredRun[] {
    return this.runs.listByStatus('recovery_required');
  }

  handle(runId: string): ManagedRunHandle | null {
    return this.registry.get(runId);
  }

  private nextQueued(): StoredRun | undefined {
    return this.runs.listByStatus('queued')[0];
  }

  private startOne(runId: string): 'started' | 'expired' | 'stop' {
    let context: RunStartContext | 'expired' | null;
    try {
      context = this.beginStart(runId, this.now());
    } catch {
      this.degraded = true;
      return 'stop';
    }
    if (context === 'expired') return 'expired';
    if (context === null) return 'stop';
    try {
      const handle = this.driver.startRun({
        sessionId: context.run.sessionId,
        workspaceId: context.run.workspaceId,
        claudeSessionId: context.session.claudeSessionId,
        runId: context.run.runId,
        adapterGeneration: context.generation,
        text: context.run.promptText ?? '',
        cwd: context.workspace.rootPath,
        deviceId: context.run.deviceId,
        permissionBroker: this.permissionGate,
        onEvent: (event) => {
          this.eventHandler?.(event, {
            runId: context.run.runId,
            generation: context.generation,
          });
        },
      });
      this.registry.register(runId, context.generation, handle);
      this.markStarted(runId, context.generation);
      handle.resumeEvents();
      return 'started';
    } catch {
      this.failStart(runId);
      return 'started';
    }
  }

  private failStart(runId: string): void {
    try {
      this.complete({ runId, status: 'failed', errorSummary: 'RUN_START_FAILED' });
    } catch {
      this.degraded = true;
    }
  }

  private terminateWithin(
    tx: SqliteTransaction,
    run: StoredRun,
    status: 'cancelled' | 'failed',
    reason: string,
  ): void {
    this.runs.update({
      ...run,
      status,
      promptText: null,
      pendingApprovalCount: 0,
      endedAt: this.now(),
      errorSummary: reason,
    });
    this.updateSessionStatus(run.sessionId, 'idle');
    this.journal.appendWithin(tx, {
      sessionId: run.sessionId,
      type: 'run.completed',
      payload: { status, reason },
      runId: run.runId,
    });
  }

  private updateSessionStatus(
    sessionId: string,
    status: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.update({
      ...session,
      status,
      lastActivityAt: this.now(),
    });
  }

  private activeCountWithin(sessionId: string): number {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const row = this.uow.connectionRef
      .prepare(
        `SELECT count(*) AS total FROM runs
         WHERE sessionId = ? AND status IN (${placeholders})`,
      )
      .get(sessionId, ...ACTIVE_STATUSES) as { total: number };
    return row.total;
  }
}

function isTerminal(status: string): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}