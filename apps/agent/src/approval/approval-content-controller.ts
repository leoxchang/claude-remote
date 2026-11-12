import { AgentError } from '../command/errors.js';
import { ApprovalChunkResponse } from './approval-types.js';
import { ApprovalStore } from './approval-store.js';

/** 每设备内容读取窗口。 */
export const CONTENT_RATE_WINDOW_MS = 60_000;

/** 每设备窗口内最多读取次数。 */
export const CONTENT_RATE_LIMIT = 120;

/** 每设备滚动窗口限流；只按认证设备计数，不看 localhost IP。 */
export class ApprovalContentRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number = CONTENT_RATE_WINDOW_MS,
    private readonly limit: number = CONTENT_RATE_LIMIT,
  ) {}

  /** 记录一次读取；窗口内超限返回 false。 */
  consume(deviceId: string, nowMonotonic: number): boolean {
    const cutoff = nowMonotonic - this.windowMs;
    const recent = (this.hits.get(deviceId) ?? []).filter(
      (at) => at > cutoff,
    );
    if (recent.length >= this.limit) {
      this.hits.set(deviceId, recent);
      return false;
    }
    recent.push(nowMonotonic);
    this.hits.set(deviceId, recent);
    return true;
  }
}

/** 内容读取依赖；settleExpired 必须同步生效。 */
export interface ApprovalContentControllerOptions {
  store: ApprovalStore;
  settleExpired?: (approvalId: string) => void;
  rateLimiter?: ApprovalContentRateLimiter;
  clock?: { monotonicNow(): number };
}

/**
 * 只读审批内容分块。
 *
 * 每次读取先按 monotonic deadline 结算 expired，再校验设备与 pending 状态；
 * 不写 Journal、不占 seq、不进入命令幂等表。
 */
export class ApprovalContentController {
  private readonly store: ApprovalStore;
  private readonly settleExpired: (approvalId: string) => void;
  private readonly rateLimiter: ApprovalContentRateLimiter;
  private readonly clock: { monotonicNow(): number };

  constructor(options: ApprovalContentControllerOptions) {
    this.store = options.store;
    this.settleExpired = options.settleExpired ?? (() => undefined);
    this.rateLimiter = options.rateLimiter ?? new ApprovalContentRateLimiter();
    this.clock = options.clock ?? { monotonicNow: () => performance.now() };
  }

  /** 返回指定 pending 审批的安全分块。 */
  readChunk(input: {
    approvalId: string;
    chunkIndex: number;
    deviceId: string;
  }): ApprovalChunkResponse {
    this.settleExpired(input.approvalId);
    if (!this.rateLimiter.consume(input.deviceId, this.clock.monotonicNow())) {
      throw new AgentError('RATE_LIMITED');
    }
    const record = this.store.getById(input.approvalId);
    if (record === null) throw new AgentError('APPROVAL_NOT_FOUND');
    if (record.deviceId !== input.deviceId) throw new AgentError('FORBIDDEN');
    if (record.status !== 'pending') {
      throw new AgentError(
        record.status === 'expired'
          ? 'APPROVAL_EXPIRED'
          : 'APPROVAL_ALREADY_RESOLVED',
      );
    }
    const content = record.content;
    if (content === null) throw new AgentError('APPROVAL_CONTENT_UNAVAILABLE');
    if (
      !Number.isInteger(input.chunkIndex) ||
      input.chunkIndex < 0 ||
      input.chunkIndex >= content.chunks.length
    ) {
      throw new AgentError('INVALID_MESSAGE');
    }
    const text = content.chunks[input.chunkIndex];
    if (text === undefined) throw new AgentError('INVALID_MESSAGE');
    return {
      approvalId: record.approvalId,
      chunkIndex: input.chunkIndex,
      chunkCount: content.chunks.length,
      encoding: content.encoding,
      byteLength: content.byteLength,
      sha256: content.sha256,
      text,
    };
  }
}