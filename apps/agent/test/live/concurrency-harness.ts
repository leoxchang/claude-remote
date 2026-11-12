import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSdkAdapter } from '../../src/adapter/agent-sdk-adapter.js';
import { AdapterEvent } from '../../src/events/adapter-events.js';

/** 一次真实 query 的终态；pending 表示尚未收到 runResult。 */
export type LiveTerminalStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'pending';

/** 单次真实 query 的脱敏指标。 */
export interface LiveRunSummary {
  label: string;
  claudeSessionId: string | null;
  initAt: number | null;
  deltaCount: number;
  firstDeltaAt: number | null;
  lastDeltaAt: number | null;
  terminalAt: number | null;
  terminalStatus: LiveTerminalStatus;
  foreignEventCount: number;
  sawMarker: boolean;
  deltaTimes: readonly number[];
}

/** 真实 query 的句柄与可观测指标。 */
export interface LiveRun {
  readonly label: string;
  readonly firstDelta: Promise<number>;
  readonly terminal: Promise<LiveTerminalStatus>;
  summary(): LiveRunSummary;
  waitForDeltaAfter(timestamp: number): Promise<number>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** 两个并发 query 的真实重叠证据。 */
export interface OverlapReport {
  liveOverlapMs: number;
  textOverlapMs: number;
  deltasFromAWhileBLive: number;
  deltasFromBWhileALive: number;
  overlapped: boolean;
}

interface RunState {
  claudeSessionId: string | null;
  initAt: number | null;
  deltaTimes: number[];
  terminalAt: number | null;
  terminalStatus: LiveTerminalStatus;
  foreignEventCount: number;
  marker: string;
  text: string;
}

const MAX_CAPTURED_TEXT = 256_000;

interface DeltaWaiter {
  after: number;
  resolve: (at: number) => void;
}

/** 在系统临时目录创建隔离 fixture 项目，不使用任何真实个人项目。 */
export async function createFixtureProject(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `s02-conc-${label}-`));
  await writeFile(
    join(root, 'README.md'),
    `# S02 CONC-01 fixture ${label}\n\nIsolated project for concurrency checks.\n`,
    'utf8',
  );
  return root;
}

/** 启动一次真实 SDK run；事件回调按 run 隔离。 */
export function startLiveRun(
  adapter: AgentSdkAdapter,
  options: { label: string; cwd: string; prompt: string; marker: string },
): LiveRun {
  const state: RunState = {
    claudeSessionId: null,
    initAt: null,
    deltaTimes: [],
    terminalAt: null,
    terminalStatus: 'pending',
    foreignEventCount: 0,
    marker: options.marker,
    text: '',
  };
  const waiters: DeltaWaiter[] = [];
  const firstDelta = createDeferred<number>();
  const terminal = createDeferred<LiveTerminalStatus>();
  const runId = `run_${options.label}_${Date.now()}`;
  const sessionId = `session_${options.label}`;

  const handlePromise = adapter.startRun({
    sessionId,
    claudeSessionId: null,
    runId,
    text: options.prompt,
    cwd: options.cwd,
    onEvent: (event) => {
      if (event.sessionId !== sessionId || event.runId !== runId) {
        state.foreignEventCount += 1;
        console.error(
          `cross-talk: run ${options.label} received event for ${event.runId}`,
        );
        return;
      }
      recordEvent(event, state, waiters, firstDelta, terminal);
    },
  });

  return {
    label: options.label,
    firstDelta: firstDelta.promise,
    terminal: terminal.promise,
    summary: () => summarize(options.label, state),
    waitForDeltaAfter: (timestamp) => {
      const observed = state.deltaTimes.find((at) => at > timestamp);
      if (observed !== undefined) return Promise.resolve(observed);
      return new Promise<number>((resolve) => {
        waiters.push({ after: timestamp, resolve });
      });
    },
    interrupt: async () => {
      const handle = await handlePromise;
      await handle.interrupt();
    },
    close: async () => {
      try {
        const handle = await handlePromise;
        handle.close();
      } catch (error: unknown) {
        console.error(`close failed for run ${options.label}`, error);
      }
    },
  };
}

/** 计算两个 run 是否真正并存，而不是先后完成。 */
export function analyzeOverlap(
  a: LiveRunSummary,
  b: LiveRunSummary,
): OverlapReport {
  const liveA = liveWindow(a);
  const liveB = liveWindow(b);
  if (liveA === null || liveB === null) {
    return {
      liveOverlapMs: 0,
      textOverlapMs: 0,
      deltasFromAWhileBLive: 0,
      deltasFromBWhileALive: 0,
      overlapped: false,
    };
  }
  const liveOverlapMs =
    Math.min(liveA.end, liveB.end) - Math.max(liveA.start, liveB.start);
  const deltasFromAWhileBLive = countWithin(
    a.deltaTimes,
    liveB.start,
    liveB.end,
  );
  const deltasFromBWhileALive = countWithin(
    b.deltaTimes,
    liveA.start,
    liveA.end,
  );
  return {
    liveOverlapMs,
    textOverlapMs: textWindowOverlap(a, b),
    deltasFromAWhileBLive,
    deltasFromBWhileALive,
    overlapped:
      liveOverlapMs > 0 &&
      deltasFromAWhileBLive > 0 &&
      deltasFromBWhileALive > 0,
  };
}

/** 输出可写入证据文档的脱敏摘要：不含正文、绝对路径或完整 session id。 */
export function toEvidence(
  scenario: string,
  runs: readonly LiveRun[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const summaries = runs.map((run) => run.summary());
  const sessionPrefixes = summaries.map((item) =>
    item.claudeSessionId === null ? null : item.claudeSessionId.slice(0, 8),
  );
  return {
    scenario,
    at: new Date().toISOString(),
    node: process.version,
    runs: summaries.map((item, index) => ({
      label: item.label,
      claudeSessionPrefix: sessionPrefixes[index],
      deltaCount: item.deltaCount,
      initAt: item.initAt,
      firstDeltaAt: item.firstDeltaAt,
      lastDeltaAt: item.lastDeltaAt,
      terminalAt: item.terminalAt,
      terminalStatus: item.terminalStatus,
      foreignEventCount: item.foreignEventCount,
      sawMarker: item.sawMarker,
    })),
    claudeSessionsDistinct:
      new Set(sessionPrefixes.filter((prefix) => prefix !== null)).size ===
      summaries.length,
    ...extra,
  };
}

/** 超时包装；超时后原 promise 的拒绝被吞掉，避免 unhandled rejection。 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function recordEvent(
  event: AdapterEvent,
  state: RunState,
  waiters: DeltaWaiter[],
  firstDelta: Deferred<number>,
  terminal: Deferred<LiveTerminalStatus>,
): void {
  if (event.kind === 'init') {
    state.claudeSessionId = event.claudeSessionId;
    state.initAt = Date.now();
    return;
  }
  if (event.kind === 'textDelta') {
    const at = Date.now();
    state.deltaTimes.push(at);
    appendText(state, event.text);
    firstDelta.resolveOnce(at);
    for (const waiter of waiters.filter((item) => at > item.after)) {
      waiter.resolve(at);
    }
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter !== undefined && at > waiter.after) waiters.splice(index, 1);
    }
    return;
  }
  if (event.kind === 'assistantCompleted') {
    appendText(
      state,
      event.content.map((block) => block.text).join(''),
    );
    return;
  }
  if (event.kind === 'runResult') {
    state.terminalAt = Date.now();
    state.terminalStatus = event.status;
    terminal.resolveOnce(event.status);
  }
}

function summarize(label: string, state: RunState): LiveRunSummary {
  return {
    label,
    claudeSessionId: state.claudeSessionId,
    initAt: state.initAt,
    deltaCount: state.deltaTimes.length,
    firstDeltaAt: state.deltaTimes[0] ?? null,
    lastDeltaAt: state.deltaTimes[state.deltaTimes.length - 1] ?? null,
    terminalAt: state.terminalAt,
    terminalStatus: state.terminalStatus,
    foreignEventCount: state.foreignEventCount,
    sawMarker: state.text.includes(state.marker),
    deltaTimes: [...state.deltaTimes],
  };
}

function appendText(state: RunState, chunk: string): void {
  if (state.text.length >= MAX_CAPTURED_TEXT) return;
  state.text += chunk;
}

/** 会话存活窗口：init 到终态；未终态时以最后一个事件为界。 */
function liveWindow(run: LiveRunSummary): { start: number; end: number } | null {
  if (run.initAt === null) return null;
  const end = run.terminalAt ?? run.lastDeltaAt ?? run.initAt;
  return { start: run.initAt, end };
}

/** 两个 run 的文本 delta 时间窗交集，仅作辅助指标。 */
function textWindowOverlap(a: LiveRunSummary, b: LiveRunSummary): number {
  if (
    a.firstDeltaAt === null ||
    a.lastDeltaAt === null ||
    b.firstDeltaAt === null ||
    b.lastDeltaAt === null
  ) {
    return 0;
  }
  return (
    Math.min(a.lastDeltaAt, b.lastDeltaAt) -
    Math.max(a.firstDeltaAt, b.firstDeltaAt)
  );
}

function countWithin(
  times: readonly number[],
  from: number,
  to: number,
): number {
  let count = 0;
  for (const at of times) {
    if (at >= from && at <= to) count += 1;
  }
  return count;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolveOnce(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let settled = false;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolveOnce: (value: T) => {
      if (settled) return;
      settled = true;
      resolveFn?.(value);
    },
  };
}