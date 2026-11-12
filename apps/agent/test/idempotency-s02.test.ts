import { describe, expect, it } from 'vitest';

import {
  canonicalRequestFingerprint,
  CommandIdentity,
} from '../src/command/canonical-request.js';
import { InMemoryIdempotency } from '../src/command/idempotency.js';

function identity(
  overrides: Partial<CommandIdentity> = {},
): CommandIdentity {
  return {
    commandId: 'cmd_1',
    type: 'prompt.send',
    workspaceId: 'ws_a',
    sessionId: 'session_a',
    payload: { text: 'hello', options: { b: 1, a: 2 } },
    ...overrides,
  };
}

describe('canonicalRequestFingerprint', () => {
  it('ignores object key order but keeps array order', () => {
    const first = canonicalRequestFingerprint(
      identity({ payload: { text: 'hello', options: { a: 2, b: 1 } } }),
    );
    const reordered = canonicalRequestFingerprint(
      identity({ payload: { options: { b: 1, a: 2 }, text: 'hello' } }),
    );
    const arrayChanged = canonicalRequestFingerprint(
      identity({ payload: { text: 'hello', options: ['a', 'b'] } }),
    );
    const arrayReordered = canonicalRequestFingerprint(
      identity({ payload: { text: 'hello', options: ['b', 'a'] } }),
    );

    expect(first).toBe(reordered);
    expect(arrayChanged).not.toBe(arrayReordered);
  });

  it('changes when type, workspace, session or run changes', () => {
    const base = canonicalRequestFingerprint(identity());

    expect(canonicalRequestFingerprint(identity({ type: 'run.cancel' }))).not.toBe(base);
    expect(
      canonicalRequestFingerprint(identity({ workspaceId: 'ws_b' })),
    ).not.toBe(base);
    expect(
      canonicalRequestFingerprint(identity({ sessionId: 'session_b' })),
    ).not.toBe(base);
    expect(canonicalRequestFingerprint(identity({ runId: 'run_b' }))).not.toBe(
      base,
    );
  });
});

describe('InMemoryIdempotency', () => {
  it('replays the first result for an identical request', async () => {
    const store = new InMemoryIdempotency();
    let calls = 0;

    const first = await store.execute(identity(), async () => {
      calls += 1;
      return 'accepted';
    });
    const duplicate = await store.execute(
      identity({ payload: { options: { b: 1, a: 2 }, text: 'hello' } }),
      async () => {
        calls += 1;
        return 'second';
      },
    );

    expect(calls).toBe(1);
    expect(first).toEqual({ value: 'accepted', duplicate: false });
    expect(duplicate).toEqual({ value: 'accepted', duplicate: true });
  });

  it('rejects a reused commandId with different content', async () => {
    const store = new InMemoryIdempotency();
    await store.execute(identity(), async () => 'accepted');

    await expect(
      store.execute(identity({ payload: { text: 'different' } }), async () => 'bad'),
    ).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' });
    await expect(
      store.execute(identity({ sessionId: 'session_b' }), async () => 'bad'),
    ).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' });
    await expect(
      store.execute(identity({ type: 'run.cancel' }), async () => 'bad'),
    ).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' });
  });

  it('executes once for concurrent retries', async () => {
    const store = new InMemoryIdempotency();
    let calls = 0;
    const handler = async (): Promise<string> => {
      calls += 1;
      return 'accepted';
    };

    const [first, second] = await Promise.all([
      store.execute(identity(), handler),
      store.execute(identity(), handler),
    ]);

    expect(calls).toBe(1);
    expect(first.value).toBe('accepted');
    expect(second).toEqual({ value: 'accepted', duplicate: true });
  });

  it('does not retain a secret prompt while detecting conflicting reuse', async () => {
    const store = new InMemoryIdempotency();
    const secret = 'do-not-store-this-prompt';
    await store.execute(
      identity({ payload: { text: secret } }),
      async () => 'accepted',
    );

    await expect(
      store.execute(identity({ payload: { text: 'different' } }), async () =>
        'bad',
      ),
    ).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' });
    expect(JSON.stringify(store)).not.toContain(secret);
  });
});