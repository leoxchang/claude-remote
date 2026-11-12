import { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentSdkAdapter,
  QueryFactoryParams,
} from '../src/adapter/agent-sdk-adapter.js';
import { ManagedRunStart } from '../src/adapter/managed-run-driver.js';
import { AdapterEvent } from '../src/events/adapter-events.js';
import { denyAllPermissionGate } from './permission-gate-fakes.js';

interface FakeQuery {
  close: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  release: () => void;
  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage>;
}

function controlledQuery(): FakeQuery {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    close: vi.fn(),
    interrupt: vi.fn(async () => ({})),
    release: () => release?.(),
    async *[Symbol.asyncIterator]() {
      await gate;
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'claude_01',
      } as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
      } as SDKMessage;
      await gate;
    },
  };
}

function input(overrides: Partial<ManagedRunStart> = {}): ManagedRunStart {
  return {
    sessionId: 'session_01',
    workspaceId: 'ws_alpha',
    claudeSessionId: null,
    runId: 'run_01',
    adapterGeneration: 3,
    text: 'hello',
    cwd: '/tmp/s02-fixture',
    deviceId: 'device_1',
    permissionBroker: denyAllPermissionGate(),
    onEvent: () => undefined,
    ...overrides,
  };
}

function adapterWith(query: FakeQuery): {
  adapter: AgentSdkAdapter;
  calls: QueryFactoryParams[];
} {
  const calls: QueryFactoryParams[] = [];
  const adapter = new AgentSdkAdapter({
    queryFactory: (params) => {
      calls.push(params);
      return query as unknown as Query;
    },
  });
  return { adapter, calls };
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('AgentSdkAdapter as ManagedRunDriver', () => {
  it('returns a handle synchronously and creates the query in the same call', () => {
    const query = controlledQuery();
    const { adapter, calls } = adapterWith(query);

    const handle = adapter.startRun(input());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({
      cwd: '/tmp/s02-fixture',
      permissionMode: 'default',
    });
    expect(calls[0]?.options.hooks).toBeUndefined();
    expect(handle.resumeEvents).toBeTypeOf('function');
  });

  it('buffers events until resumeEvents is called', async () => {
    const query = controlledQuery();
    const { adapter } = adapterWith(query);
    const events: AdapterEvent[] = [];
    const handle = adapter.startRun(
      input({ onEvent: (event) => events.push(event) }),
    );

    query.release();
    await flush();
    expect(events).toEqual([]);

    handle.resumeEvents();
    expect(events.map((event) => event.kind)).toEqual(['init', 'runResult']);
    await handle.close();
  });

  it('closes idempotently', async () => {
    const query = controlledQuery();
    const { adapter } = adapterWith(query);
    const handle = adapter.startRun(input());

    await handle.close();
    await handle.close();

    expect(query.close).toHaveBeenCalledTimes(1);
  });

  it('resumes with the session Claude id and reports the run identity', async () => {
    const query = controlledQuery();
    const { adapter, calls } = adapterWith(query);
    const events: AdapterEvent[] = [];
    const handle = adapter.startRun(
      input({
        claudeSessionId: 'claude_01',
        onEvent: (event) => events.push(event),
      }),
    );
    handle.resumeEvents();
    query.release();
    await flush();

    expect(calls[0]?.options.resume).toBe('claude_01');
    expect(events[0]).toMatchObject({
      kind: 'init',
      sessionId: 'session_01',
      runId: 'run_01',
      claudeSessionId: 'claude_01',
    });
    await handle.close();
  });
});