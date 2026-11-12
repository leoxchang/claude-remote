import { AdapterEvent } from '../events/adapter-events.js';
import {
  ManagedRunDriver,
  ManagedRunHandle,
  ManagedRunStart,
} from './managed-run-driver.js';

/** 测试用驱动：记录启动、可注入失败、缓冲 resumeEvents 之前的事件。 */
export class MockManagedRunDriver implements ManagedRunDriver {
  readonly started: ManagedRunStart[] = [];
  readonly interruptCalls: string[] = [];
  readonly closedRunIds: string[] = [];
  failNextStart = false;
  /** interrupt 时是否自动发出 cancelled 终态。 */
  interruptBehavior: 'silent' | 'cancelled' = 'silent';

  private readonly buffered = new Map<string, AdapterEvent[]>();
  private readonly resumed = new Set<string>();

  startRun(input: ManagedRunStart): ManagedRunHandle {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error('mock start failed');
    }
    this.started.push(input);
    return {
      interrupt: async () => {
        this.interruptCalls.push(input.runId);
        if (this.interruptBehavior === 'cancelled') {
          this.emit(input.runId, {
            kind: 'runResult',
            sessionId: input.sessionId,
            runId: input.runId,
            status: 'cancelled',
          });
        }
      },
      close: async () => {
        this.closedRunIds.push(input.runId);
      },
      resumeEvents: () => {
        this.resumed.add(input.runId);
        const pending = this.buffered.get(input.runId) ?? [];
        this.buffered.set(input.runId, []);
        for (const event of pending) input.onEvent(event);
      },
    };
  }

  /** 已启动的 runId，按启动顺序。 */
  startedRunIds(): string[] {
    return this.started.map((start) => start.runId);
  }

  /** 向指定 run 投递事件；resumeEvents 之前先缓冲。 */
  emit(runId: string, event: AdapterEvent): void {
    const start = this.started.find((entry) => entry.runId === runId);
    if (start === undefined) throw new Error('run was not started');
    if (!this.resumed.has(runId)) {
      const pending = this.buffered.get(runId) ?? [];
      pending.push(event);
      this.buffered.set(runId, pending);
      return;
    }
    start.onEvent(event);
  }
}