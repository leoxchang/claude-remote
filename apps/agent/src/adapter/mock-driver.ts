import { AdapterEvent } from '../events/adapter-events.js';
import {
  ManagedRunDriver,
  ManagedRunHandle,
  ManagedRunStart,
} from './managed-run-driver.js';

/** 测试用中断行为。 */
export interface MockRunScript {
  interruptBehavior: 'silent' | 'emit-cancelled' | 'emit-interrupted';
}

/** 可控驱动：测试自行决定何时发出事件与终态。 */
export class MockDriver implements ManagedRunDriver {
  readonly runs: ManagedRunStart[] = [];
  readonly script: MockRunScript = { interruptBehavior: 'silent' };
  closedHandles = 0;

  private current: ManagedRunStart | null = null;

  startRun(input: ManagedRunStart): ManagedRunHandle {
    this.runs.push(input);
    this.current = input;
    return {
      interrupt: async () => {
        if (this.script.interruptBehavior === 'emit-cancelled') {
          this.finish('cancelled');
        }
        if (this.script.interruptBehavior === 'emit-interrupted') {
          this.finish('interrupted');
        }
      },
      close: async () => {
        this.closedHandles += 1;
      },
      resumeEvents: () => undefined,
    };
  }

  /** 向当前 run 注入一个事件。 */
  emit(event: AdapterEvent): void {
    this.current?.onEvent(event);
  }

  /** 向当前 run 注入终态。 */
  finish(status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'): void {
    const current = this.current;
    if (current === null) return;
    current.onEvent({
      kind: 'runResult',
      sessionId: current.sessionId,
      runId: current.runId,
      status,
    });
  }
}