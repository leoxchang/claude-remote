import { ManagedRunHandle } from './managed-run-driver.js';

interface Entry {
  generation: number;
  handle: ManagedRunHandle;
}

/** 以 runId + generation 隔离活跃句柄，旧 generation 的事件不会被接受。 */
export class AdapterRegistry {
  private readonly entries = new Map<string, Entry>();

  register(runId: string, generation: number, handle: ManagedRunHandle): void {
    this.entries.set(runId, { generation, handle });
  }

  get(runId: string): ManagedRunHandle | null {
    return this.entries.get(runId)?.handle ?? null;
  }

  remove(runId: string): void {
    this.entries.delete(runId);
  }

  /** 只接受当前 generation 的回调。 */
  assertCurrent(runId: string, generation: number): boolean {
    return this.entries.get(runId)?.generation === generation;
  }
}