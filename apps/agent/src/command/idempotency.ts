import {
  canonicalRequestFingerprint,
  CommandIdentity,
} from './canonical-request.js';
import { AgentError } from './errors.js';

/** 幂等执行结果：value 为首次结果，duplicate 表示这是重复请求。 */
export interface IdempotentResult<T> {
  value: T;
  duplicate: boolean;
}

interface Entry {
  fingerprint: string;
  promise: Promise<unknown>;
}

/**
 * 内存命令幂等表。
 *
 * 只保存首次 Promise 与请求指纹，不保存原始 payload；
 * 同一 commandId 的请求内容不一致时抛 COMMAND_ID_CONFLICT。
 */
export class InMemoryIdempotency {
  private readonly entries = new Map<string, Entry>();

  /** 同一 commandId 且请求一致时只执行一次 handler。 */
  async execute<T>(
    identity: CommandIdentity,
    handler: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    const fingerprint = canonicalRequestFingerprint(identity);
    const existing = this.entries.get(identity.commandId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new AgentError('COMMAND_ID_CONFLICT');
      }
      return { value: (await existing.promise) as T, duplicate: true };
    }
    const pending = handler();
    this.entries.set(identity.commandId, { fingerprint, promise: pending });
    return { value: await pending, duplicate: false };
  }
}