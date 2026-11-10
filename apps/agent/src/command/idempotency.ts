/** 幂等执行结果：value 为首次结果，duplicate 表示这是重复请求。 */
export interface IdempotentResult<T> {
  value: T;
  duplicate: boolean;
}

/** 内存命令幂等表；缓存首次 Promise，并发重复请求等待同一结果。 */
export class InMemoryIdempotency {
  private readonly results = new Map<string, Promise<unknown>>();

  /** 同一 commandId 只执行一次 handler。 */
  async execute<T>(
    commandId: string,
    handler: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    const existing = this.results.get(commandId);
    if (existing !== undefined) {
      return { value: (await existing) as T, duplicate: true };
    }
    const pending = handler();
    this.results.set(commandId, pending);
    return { value: await pending, duplicate: false };
  }
}