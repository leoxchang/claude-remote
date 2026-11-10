import { describe, expect, it, vi } from 'vitest';

import { InMemoryIdempotency } from '../src/command/idempotency.js';

describe('InMemoryIdempotency', () => {
  it('runs concurrent calls with the same commandId exactly once', async () => {
    const idempotency = new InMemoryIdempotency();
    let calls = 0;
    const handler = async (): Promise<string> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'value';
    };

    const [first, second] = await Promise.all([
      idempotency.execute('cmd_1', handler),
      idempotency.execute('cmd_1', handler),
    ]);

    expect(calls).toBe(1);
    expect(first).toEqual({ value: 'value', duplicate: false });
    expect(second).toEqual({ value: 'value', duplicate: true });
  });

  it('keeps different command ids independent', async () => {
    const idempotency = new InMemoryIdempotency();
    const handler = vi.fn(async () => 'value');

    await idempotency.execute('cmd_1', handler);
    await idempotency.execute('cmd_2', handler);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('replays the first failure instead of running again', async () => {
    const idempotency = new InMemoryIdempotency();
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(idempotency.execute('cmd_1', handler)).rejects.toThrow('boom');
    await expect(idempotency.execute('cmd_1', handler)).rejects.toThrow('boom');

    expect(handler).toHaveBeenCalledTimes(1);
  });
});