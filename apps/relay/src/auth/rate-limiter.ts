/** 滑动窗口限流器：每 key 在窗口内最多 maxPerWindow 次。 */
export class SlidingWindowLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
  ) {}

  /** 记录一次尝试；超限返回 false（超限尝试不挤占窗口）。 */
  allow(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter(
      (timestamp) => timestamp > windowStart,
    );
    if (recent.length >= this.maxPerWindow) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }
}