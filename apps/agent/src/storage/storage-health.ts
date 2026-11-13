/** 存储健康状态；写失败后拒绝新的副作用执行。 */
export type StorageState = 'ok' | 'limited' | 'unavailable';

export interface StorageHealthSnapshot {
  state: StorageState;
  liveBytes: number;
}

/** 单进程存储健康；degraded 后不再允许新 run/requeue/allow。 */
export class StorageHealth {
  private state: StorageState = 'ok';
  private liveBytes = 0;

  current(): StorageHealthSnapshot {
    return { state: this.state, liveBytes: this.liveBytes };
  }

  isAvailable(): boolean {
    return this.state === 'ok';
  }

  /** 写失败或容量超限后降级；不可自动恢复。 */
  degraded(reason: StorageState): void {
    if (this.state === 'unavailable') return;
    this.state = reason;
  }

  /** 容量采样；仅用于报告与限额判断。 */
  reportLiveBytes(liveBytes: number): void {
    this.liveBytes = liveBytes;
  }
}