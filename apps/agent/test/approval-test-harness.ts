import { ApprovalStore } from '../src/approval/approval-store.js';
import {
  ApprovalEventSink,
  ApprovalResolvedNotice,
  ApprovalRuntimePorts,
  ApprovalSafeError,
  ApprovalSummary,
  ApprovalTimers,
  RunApprovalContext,
  SdkPermissionRequest,
  ToolDeniedNotice,
} from '../src/approval/approval-types.js';
import { PermissionBroker } from '../src/approval/permission-broker.js';

/** 可预测的墙钟与单调时钟。 */
export class FakeClock {
  monotonic = 0;
  wall = 1_762_432_800_000;

  monotonicNow(): number {
    return this.monotonic;
  }

  wallNow(): number {
    return this.wall;
  }

  advanceMonotonic(ms: number): void {
    this.monotonic += ms;
  }

  advanceWall(ms: number): void {
    this.wall += ms;
  }
}

interface TimerEntry {
  dueAt: number;
  callback: () => void;
  cancelled: boolean;
}

/** 手动推进的定时器；只执行到期的未取消项。 */
export class FakeTimers implements ApprovalTimers {
  private now = 0;
  private readonly entries: TimerEntry[] = [];

  schedule(callback: () => void, delayMs: number): () => void {
    const entry: TimerEntry = {
      dueAt: this.now + delayMs,
      callback,
      cancelled: false,
    };
    this.entries.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  advance(ms: number): void {
    this.now += ms;
    for (const entry of [...this.entries]) {
      if (entry.cancelled || entry.dueAt > this.now) continue;
      entry.cancelled = true;
      entry.callback();
    }
  }

  activeCount(): number {
    return this.entries.filter((entry) => !entry.cancelled).length;
  }
}

/** 记录全部事件；可让第一次 requested 抛错。 */
export class RecordingEvents implements ApprovalEventSink {
  requestedEvents: ApprovalSummary[] = [];
  resolvedEvents: ApprovalResolvedNotice[] = [];
  errors: ApprovalSafeError[] = [];
  deniedEvents: ToolDeniedNotice[] = [];
  throwOnRequested = false;

  requested(summary: ApprovalSummary): void {
    if (this.throwOnRequested) {
      this.throwOnRequested = false;
      throw new Error('append failed');
    }
    this.requestedEvents.push(summary);
  }

  resolved(notice: ApprovalResolvedNotice): void {
    this.resolvedEvents.push(notice);
  }

  reportError(error: ApprovalSafeError): void {
    this.errors.push(error);
  }

  toolDenied(notice: ToolDeniedNotice): void {
    this.deniedEvents.push(notice);
  }
}

/** 可配置的运行时端口；每个 runId 绑定独立会话。 */
export class FakePorts implements ApprovalRuntimePorts {
  readonly contexts = new Map<string, RunApprovalContext>();
  readonly counts: Array<{ runId: string; count: number }> = [];
  acceptingApprovals = true;
  mode: 'deny' | 'allow_once' = 'allow_once';
  deviceIsActive = true;

  constructor(runIds: string[]) {
    for (const runId of runIds) {
      this.contexts.set(runId, {
        workspaceId: 'ws_a',
        sessionId: `session_${runId}`,
        runId,
        deviceId: 'device_1',
        workingDirectory: '/fixture/项目',
      });
    }
  }

  runContext(
    runId: string,
  ): { context: RunApprovalContext; acceptingApprovals: boolean } | null {
    const context = this.contexts.get(runId);
    if (context === undefined) return null;
    return { context, acceptingApprovals: this.acceptingApprovals };
  }

  workspaceMode(): 'deny' | 'allow_once' {
    return this.mode;
  }

  deviceActive(): boolean {
    return this.deviceIsActive;
  }

  setPendingApprovalCount(runId: string, count: number): void {
    this.counts.push({ runId, count });
  }
}

export interface BrokerHarness {
  broker: PermissionBroker;
  store: ApprovalStore;
  events: RecordingEvents;
  ports: FakePorts;
  clock: FakeClock;
  timers: FakeTimers;
}

export function setupBroker(runIds: string[] = ['run_1']): BrokerHarness {
  const store = new ApprovalStore();
  const events = new RecordingEvents();
  const ports = new FakePorts(runIds);
  const clock = new FakeClock();
  const timers = new FakeTimers();
  let counter = 0;
  const broker = new PermissionBroker({
    store,
    ports,
    events,
    clock,
    timers,
    generateApprovalId: () => {
      counter += 1;
      return `approval_${counter}`;
    },
  });
  return { broker, store, events, ports, clock, timers };
}

/** 默认合法的 Bash 审批请求。 */
export function makeRequest(
  overrides: Partial<SdkPermissionRequest> = {},
): SdkPermissionRequest {
  return {
    toolName: 'Bash',
    input: { command: 'echo S03_ALPHA', description: 'fixture' },
    signal: new AbortController().signal,
    toolUseID: 'toolu_1',
    requestId: 'req_1',
    ...overrides,
  };
}