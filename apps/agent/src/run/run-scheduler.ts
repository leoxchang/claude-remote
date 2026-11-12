import { AdapterRegistry } from '../adapter/adapter-registry.js';
import {
  ManagedRunDriver,
  ManagedRunHandle,
  PermissionGate,
} from '../adapter/managed-run-driver.js';
import { RunApprovalContext } from '../approval/approval-types.js';
import { AgentError } from '../command/errors.js';
import {
  RunRecord,
  RunStatus,
  SessionRecord,
  TerminalRunStatus,
} from '../domain/types.js';
import { AdapterEvent } from '../events/adapter-events.js';
import { EventJournal } from '../events/journal.js';
import { QueuedRunSummary } from '../events/snapshot-factory.js';
import { randomBase64Url } from '../security/random.js';
import { SessionRegistry } from '../session/session-registry.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { MAX_ACTIVE_RUNS, MAX_GLOBAL_QUEUED_RUNS } from './run-limits.js';

const RUN_ID_BYTES = 9;

/** 未装配 Broker 时的保守门面：一律拒绝，不创建审批。 */
const UNAVAILABLE_PERMISSION_GATE: PermissionGate = {
  request: (_runId, request) =>
    Promise.resolve({
      behavior: 'deny',
      message: 'Mobile approval is not available',
      interrupt: false,
      toolUseID: request.toolUseID,
    }),
};

/** prompt.send 的首次结果。 */
export interface PromptAccepted {
  sessionId: string;
  runId: string;
  status: 'queued' | 'starting';
}

/** run.cancel 的接受结果。 */
export interface CancelAccepted {
  sessionId: string;
  runId: string;
  status: 'cancelling';
}

/** queue.remove 的成功结果。 */
export interface QueueRemoved {
  sessionId: string;
  runId: string;
  status: 'cancelled';
  removed: true;
}

/** beginCancel 的内部结论；只有 started 才允许调用 interrupt。 */
export interface CancelDecision {
  outcome: 'started' | 'alreadyCancelling';
  run: RunRecord;
  handle: ManagedRunHandle | null;
}

/** 调度器依赖；事件回调由 Task 8 的 RunController 注入。 */
export interface RunSchedulerOptions {
  sessions: SessionRegistry;
  workspaces: WorkspaceManager;
  journal: EventJournal;
  driver: ManagedRunDriver;
  registry?: AdapterRegistry;
  permissionBroker?: PermissionGate;
  now?: () => number;
  generateRunId?: () => string;
  onEvent?: (
    event: AdapterEvent,
    context: { runId: string; generation: number },
  ) => void;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

/**
 * 每会话 FIFO + 全局双执行槽。
 *
 * 所有状态迁移都在同步调用栈内完成；driver.startRun 必须同步返回句柄，
 * 事件通过 onEvent 异步到达。
 */
export class RunScheduler {
  private readonly registry: AdapterRegistry;
  private permissionBroker: PermissionGate;
  private readonly sessions: SessionRegistry;
  private readonly now: () => number;
  private eventHandler:
    | ((event: AdapterEvent, context: { runId: string; generation: number }) => void)
    | null = null;
  private generation = 0;
  private enqueueOrder = 0;

  constructor(private readonly options: RunSchedulerOptions) {
    this.registry = options.registry ?? new AdapterRegistry();
    this.permissionBroker =
      options.permissionBroker ?? UNAVAILABLE_PERMISSION_GATE;
    this.sessions = options.sessions;
    this.now = options.now ?? Date.now;
    this.eventHandler = options.onEvent ?? null;
  }

  /** 由 RunController 注入事件处理；同一时刻只有一个处理者。 */
  setEventHandler(
    handler: (event: AdapterEvent, context: { runId: string; generation: number }) => void,
  ): void {
    this.eventHandler = handler;
  }

  /** 装配真实 Broker；未设置时保持一律拒绝。 */
  setPermissionBroker(gate: PermissionGate): void {
    this.permissionBroker = gate;
  }

  /** 事件是否仍属于该 run 的当前 generation。 */
  isCurrent(runId: string, generation: number): boolean {
    return this.registry.assertCurrent(runId, generation);
  }

  /** 等待句柄关闭并从注册表移除；关闭失败不阻塞终态。 */
  async closeHandle(runId: string): Promise<void> {
    const handle = this.registry.get(runId);
    this.registry.remove(runId);
    if (handle === null) return;
    try {
      await handle.close();
    } catch {
      // 关闭失败只影响清理；终态仍必须写入。
    }
  }

  /** 接受一条 prompt：先入队，再在同步临界区内尝试调度。 */
  enqueue(input: {
    sessionId: string;
    text: string;
    commandId: string;
    traceId: string;
    deviceId: string;
  }): PromptAccepted {
    const session = this.sessions.get(input.sessionId);
    if (session.lifecycle === 'archived') {
      throw new AgentError('SESSION_ARCHIVED');
    }
    const workspace = this.options.workspaces.assertUsable(session.workspaceId);
    const sessionLimit = workspace.policy.perSessionQueueLimit;
    if (session.queue.length >= sessionLimit) {
      throw new AgentError('QUEUE_FULL', 'QUEUE_FULL', false, {
        scope: 'session',
        limit: sessionLimit,
      });
    }
    if (this.globalQueuedCount() >= MAX_GLOBAL_QUEUED_RUNS) {
      throw new AgentError('QUEUE_FULL', 'QUEUE_FULL', false, {
        scope: 'global',
        limit: MAX_GLOBAL_QUEUED_RUNS,
      });
    }

    const now = this.now();
    this.enqueueOrder += 1;
    const record: RunRecord = {
      runId: this.options.generateRunId?.() ?? `run_${randomBase64Url(RUN_ID_BYTES)}`,
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      deviceId: input.deviceId,
      commandId: input.commandId,
      traceId: input.traceId,
      text: input.text,
      status: 'queued',
      pendingApprovalCount: 0,
      enqueueOrder: this.enqueueOrder,
      enqueuedAt: now,
      startedAt: null,
      endedAt: null,
      errorSummary: null,
    };
    this.sessions.update(session.sessionId, (current) => ({
      ...current,
      queue: [...current.queue, record],
      runsById: new Map([...current.runsById, [record.runId, record]]),
      lastActivityAt: now,
    }));
    this.options.journal.append({
      sessionId: record.sessionId,
      type: 'run.queued',
      runId: record.runId,
      payload: { enqueuedAt: now },
    });

    this.drain();
    const after = this.sessions.get(session.sessionId);
    return {
      sessionId: record.sessionId,
      runId: record.runId,
      status: after.activeRun?.runId === record.runId ? 'starting' : 'queued',
    };
  }

  /** 移除一个 queued run；从不调用 Adapter。 */
  removeQueued(sessionId: string, runId: string): QueueRemoved {
    const session = this.sessions.get(sessionId);
    const index = session.queue.findIndex((run) => run.runId === runId);
    if (index < 0) {
      if (session.activeRun?.runId === runId || session.runsById.has(runId)) {
        throw new AgentError('RUN_NOT_QUEUED');
      }
      const owner = this.sessions.findRunOwner(runId);
      if (owner !== null && owner !== sessionId) {
        throw new AgentError('RUN_SESSION_MISMATCH');
      }
      throw new AgentError('RUN_NOT_FOUND');
    }
    const queued = session.queue[index];
    if (queued === undefined) throw new AgentError('RUN_NOT_FOUND');
    const now = this.now();
    const cancelled: RunRecord = {
      ...queued,
      status: 'cancelled',
      text: null,
      endedAt: now,
    };
    this.sessions.update(sessionId, (current) => {
      const runsById = new Map(current.runsById);
      runsById.set(runId, cancelled);
      return {
        ...current,
        queue: current.queue.filter((run) => run.runId !== runId),
        runsById,
        lastActivityAt: now,
      };
    });
    this.options.journal.append({
      sessionId,
      type: 'run.completed',
      runId,
      payload: { status: 'cancelled', reason: 'queue_removed' },
    });
    this.drain();
    return { sessionId, runId, status: 'cancelled', removed: true };
  }

  /** 标记 starting 的 run 已进入可执行阶段。 */
  markRunning(sessionId: string, runId: string): void {
    const session = this.sessions.get(sessionId);
    const active = session.activeRun;
    if (active === null || active.runId !== runId) {
      throw new AgentError('RUN_NOT_FOUND');
    }
    if (active.status !== 'starting') return;
    const running: RunRecord = { ...active, status: 'running' };
    this.sessions.update(sessionId, (current) => ({
      ...current,
      activeRun: running,
      runsById: new Map([...current.runsById, [runId, running]]),
    }));
    this.options.journal.append({
      sessionId,
      type: 'session.status',
      runId,
      payload: { state: 'running', status: 'running' },
    });
  }

  /**
   * 更新 run 的 pending 审批数。
   *
   * 首个 pending 使 starting/running 进入 waiting_approval，
   * 计数归零后回到 running；cancelling/终态不受影响。
   */
  setPendingApprovalCount(runId: string, count: number): void {
    const sessionId = this.sessions.findRunOwner(runId);
    if (sessionId === null) return;
    const session = this.sessions.get(sessionId);
    const active = session.activeRun;
    if (active === null || active.runId !== runId) return;
    const nextStatus = approvalStatus(active.status, count);
    const updated: RunRecord = {
      ...active,
      status: nextStatus,
      pendingApprovalCount: count,
    };
    this.sessions.update(sessionId, (current) => ({
      ...current,
      activeRun: updated,
      runsById: new Map([...current.runsById, [runId, updated]]),
    }));
    if (nextStatus !== active.status) {
      this.options.journal.append({
        sessionId,
        type: 'session.status',
        runId,
        payload: {
          state: nextStatus,
          status: nextStatus,
          pendingApprovalCount: count,
        },
      });
    }
  }

  /** 审批的 run 绑定；非当前 run 或终态返回 null，cancelling 不接受审批。 */
  approvalContext(
    runId: string,
  ): { context: RunApprovalContext; acceptingApprovals: boolean } | null {
    const sessionId = this.sessions.findRunOwner(runId);
    if (sessionId === null) return null;
    const session = this.sessions.get(sessionId);
    const active = session.activeRun;
    if (active === null || active.runId !== runId) return null;
    const workingDirectory = this.workingDirectory(active.workspaceId);
    if (workingDirectory === null) return null;
    if (active.status === 'cancelling') {
      return {
        context: {
          workspaceId: active.workspaceId,
          sessionId: active.sessionId,
          runId: active.runId,
          deviceId: active.deviceId,
          workingDirectory,
        },
        acceptingApprovals: false,
      };
    }
    if (
      active.status !== 'starting' &&
      active.status !== 'running' &&
      active.status !== 'waiting_approval'
    ) {
      return null;
    }
    return {
      context: {
        workspaceId: active.workspaceId,
        sessionId: active.sessionId,
        runId: active.runId,
        deviceId: active.deviceId,
        workingDirectory,
      },
      acceptingApprovals: true,
    };
  }

  /** 开始取消；只有 outcome=started 时调用方才能 interrupt。 */
  beginCancel(sessionId: string, runId: string): CancelDecision {
    const session = this.sessions.get(sessionId);
    const active = session.activeRun;
    if (active === null || active.runId !== runId) {
      if (session.runsById.has(runId)) {
        throw new AgentError('RUN_NOT_ACTIVE');
      }
      const owner = this.sessions.findRunOwner(runId);
      if (owner !== null && owner !== sessionId) {
        throw new AgentError('RUN_SESSION_MISMATCH');
      }
      throw new AgentError('RUN_NOT_FOUND');
    }
    if (active.status === 'cancelling') {
      return {
        outcome: 'alreadyCancelling',
        run: active,
        handle: this.registry.get(runId),
      };
    }
    const cancelling: RunRecord = { ...active, status: 'cancelling' };
    this.sessions.update(sessionId, (current) => ({
      ...current,
      activeRun: cancelling,
      runsById: new Map([...current.runsById, [runId, cancelling]]),
    }));
    return {
      outcome: 'started',
      run: cancelling,
      handle: this.registry.get(runId),
    };
  }

  /** 写入终态、释放槽位并继续调度。 */
  complete(input: {
    sessionId: string;
    runId: string;
    status: TerminalRunStatus;
    errorSummary?: string;
  }): void {
    const session = this.sessions.get(input.sessionId);
    const known =
      session.activeRun?.runId === input.runId
        ? session.activeRun
        : session.runsById.get(input.runId);
    if (known === undefined) throw new AgentError('RUN_NOT_FOUND');
    if (TERMINAL_STATUSES.has(known.status)) return;

    const now = this.now();
    const terminal: RunRecord = {
      ...known,
      status: input.status,
      text: null,
      pendingApprovalCount: 0,
      endedAt: now,
      errorSummary: input.errorSummary ?? null,
    };
    this.sessions.update(input.sessionId, (current) => {
      const runsById = new Map(current.runsById);
      runsById.set(terminal.runId, terminal);
      return {
        ...current,
        runsById,
        activeRun:
          current.activeRun?.runId === terminal.runId
            ? null
            : current.activeRun,
        lastRunStatus: input.status,
        lastActivityAt: now,
      };
    });
    this.releaseHandle(terminal.runId);
    this.options.journal.append({
      sessionId: input.sessionId,
      type: 'run.completed',
      runId: terminal.runId,
      payload: {
        status: input.status,
        ...(input.errorSummary === undefined
          ? {}
          : { error: { code: input.errorSummary, message: input.errorSummary } }),
      },
    });
    this.drain();
  }

  /** 当前占用执行槽的 run 数。 */
  activeCount(): number {
    return this.sessions
      .all()
      .filter((session) => session.activeRun !== null).length;
  }

  /** 全局 queued run 总数。 */
  queuedRunCount(): number {
    return this.globalQueuedCount();
  }

  /** 目标会话的排队摘要，按 FIFO 顺序。 */
  queuedRuns(sessionId: string): QueuedRunSummary[] {
    return this.sessions
      .get(sessionId)
      .queue.map((run) => ({
        runId: run.runId,
        commandId: run.commandId,
        status: 'queued' as const,
        enqueuedAt: run.enqueuedAt,
      }));
  }

  /** workspace 内是否还有活跃或排队 run。 */
  hasActiveOrQueued(workspaceId: string): boolean {
    return this.sessions.all().some(
      (session) =>
        session.workspaceId === workspaceId &&
        (session.activeRun !== null || session.queue.length > 0),
    );
  }

  /** 当前句柄；queued run 没有句柄。 */
  handle(runId: string): ManagedRunHandle | null {
    return this.registry.get(runId);
  }

  private globalQueuedCount(): number {
    return this.sessions
      .all()
      .reduce((total, session) => total + session.queue.length, 0);
  }

  /** 解析项目真实路径；路径失效时审批 fail closed。 */
  private workingDirectory(workspaceId: string): string | null {
    try {
      return this.options.workspaces.assertUsable(workspaceId).rootPath;
    } catch {
      return null;
    }
  }

  private drain(): void {
    while (this.activeCount() < MAX_ACTIVE_RUNS) {
      const candidate = this.nextEligible();
      if (candidate === undefined) return;
      this.start(candidate.sessionId, candidate.record.runId);
    }
  }

  private nextEligible(): { sessionId: string; record: RunRecord } | undefined {
    let best: { sessionId: string; record: RunRecord } | undefined;
    for (const session of this.sessions.all()) {
      if (session.activeRun !== null) continue;
      const head = session.queue[0];
      if (head === undefined) continue;
      if (best === undefined || head.enqueueOrder < best.record.enqueueOrder) {
        best = { sessionId: session.sessionId, record: head };
      }
    }
    return best;
  }

  private start(sessionId: string, runId: string): void {
    const now = this.now();
    const generation = ++this.generation;
    let record: RunRecord | null = null;
    let claudeSessionId: string | null = null;
    this.sessions.update(sessionId, (current: SessionRecord) => {
      const head = current.queue.find((run) => run.runId === runId);
      if (head === undefined) return current;
      record = {
        ...head,
        status: 'starting',
        startedAt: now,
      };
      claudeSessionId = current.claudeSessionId;
      return {
        ...current,
        queue: current.queue.filter((run) => run.runId !== runId),
        activeRun: record,
        runsById: new Map([...current.runsById, [runId, record]]),
        lastActivityAt: now,
      };
    });
    if (record === null) return;
    const starting: RunRecord = record;

    try {
      const workspace = this.options.workspaces.assertUsable(starting.workspaceId);
      const handle = this.options.driver.startRun({
        sessionId,
        workspaceId: starting.workspaceId,
        claudeSessionId,
        runId: starting.runId,
        adapterGeneration: generation,
        text: starting.text ?? '',
        cwd: workspace.rootPath,
        deviceId: starting.deviceId,
        permissionBroker: this.permissionBroker,
        onEvent: (event) => {
          this.eventHandler?.(event, { runId: starting.runId, generation });
        },
      });
      this.registry.register(starting.runId, generation, handle);
      this.options.journal.append({
        sessionId,
        type: 'run.started',
        runId: starting.runId,
        payload: { startedAt: now, status: 'starting' },
      });
      handle.resumeEvents();
    } catch {
      this.complete({
        sessionId,
        runId: starting.runId,
        status: 'failed',
        errorSummary: 'RUN_START_FAILED',
      });
    }
  }

  private releaseHandle(runId: string): void {
    const handle = this.registry.get(runId);
    this.registry.remove(runId);
    if (handle === null) return;
    void handle.close().catch(() => undefined);
  }
}

/** pending 数到 run 状态的派生；取消与终态不因计数变化。 */
function approvalStatus(current: RunStatus, count: number): RunStatus {
  if (count > 0) {
    if (
      current === 'starting' ||
      current === 'running' ||
      current === 'waiting_approval'
    ) {
      return 'waiting_approval';
    }
    return current;
  }
  if (current === 'waiting_approval') return 'running';
  return current;
}