import { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentSdkAdapter,
  QueryFactoryParams,
} from '../src/adapter/agent-sdk-adapter.js';
import { StartRunInput } from '../src/adapter/agent-driver.js';
import { AdapterEvent } from '../src/events/adapter-events.js';

interface FakeQuery {
  messages: unknown[];
  close: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage>;
}

function fakeQuery(messages: unknown[]): FakeQuery {
  return {
    messages,
    close: vi.fn(),
    interrupt: vi.fn(async () => ({})),
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message as SDKMessage;
      }
    },
  };
}

function adapterWith(messages: unknown[]): {
  adapter: AgentSdkAdapter;
  calls: QueryFactoryParams[];
  query: FakeQuery;
} {
  const query = fakeQuery(messages);
  const calls: QueryFactoryParams[] = [];
  const adapter = new AgentSdkAdapter({
    queryFactory: (params) => {
      calls.push(params);
      return query as unknown as Query;
    },
  });
  return { adapter, calls, query };
}

const input = (overrides: Partial<StartRunInput> = {}): StartRunInput => ({
  sessionId: 'session_01',
  claudeSessionId: null,
  runId: 'run_01',
  text: 'hello',
  cwd: '/tmp/s01-fixture',
  onEvent: () => undefined,
  ...overrides,
});

describe('AgentSdkAdapter options', () => {
  it('uses the S00 verified presets, settings and cwd', async () => {
    const { adapter, calls } = adapterWith([]);

    await adapter.startRun(input());

    expect(calls[0]?.options).toMatchObject({
      cwd: '/tmp/s01-fixture',
      permissionMode: 'default',
      persistSession: true,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
    });
  });

  it('sends exactly one prompt message', async () => {
    const { adapter, calls } = adapterWith([]);

    await adapter.startRun(input());

    const messages: unknown[] = [];
    for await (const message of calls[0]?.prompt ?? []) messages.push(message);
    expect(messages).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'hello' },
        parent_tool_use_id: null,
      },
    ]);
  });

  it('resumes only when a claude session id is known', async () => {
    const { adapter, calls } = adapterWith([]);
    await adapter.startRun(input());
    await adapter.startRun(input({ claudeSessionId: 'claude_01' }));

    expect(calls[0]?.options.resume).toBeUndefined();
    expect(calls[1]?.options.resume).toBe('claude_01');
  });

  it('denies permission requests without updated permissions', async () => {
    const { adapter, calls } = adapterWith([]);
    await adapter.startRun(input());

    const result = await calls[0]?.options.canUseTool?.(
      'Bash',
      { command: 'printf hi' },
      { signal: new AbortController().signal } as never,
    );

    expect(result).toEqual({
      behavior: 'deny',
      message: 'Mobile approval is not available in S01',
      interrupt: false,
    });
  });
});

describe('AgentSdkAdapter message mapping', () => {
  const messages = [
    { type: 'system', subtype: 'init', session_id: 'claude_01' },
    {
      type: 'stream_event',
      session_id: 'claude_01',
      event: { type: 'message_start', message: { id: 'msg_api_1' } },
    },
    {
      type: 'stream_event',
      session_id: 'claude_01',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      },
    },
    {
      type: 'assistant',
      session_id: 'claude_01',
      message: {
        id: 'msg_api_1',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.ts' } },
        ],
      },
    },
    {
      type: 'user',
      session_id: 'claude_01',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body', is_error: false },
        ],
      },
    },
    { type: 'result', subtype: 'success', session_id: 'claude_01', is_error: false },
  ];

  it('maps SDK messages to adapter events and closes the query', async () => {
    const { adapter, query } = adapterWith(messages);
    const events: AdapterEvent[] = [];

    await adapter.startRun(input({ onEvent: (event) => events.push(event) }));
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === 'runResult')).toBe(true);
    });

    expect(events.map((event) => event.kind)).toEqual([
      'init',
      'textDelta',
      'assistantCompleted',
      'toolStarted',
      'toolOutput',
      'toolCompleted',
      'runResult',
    ]);
    expect(events[1]).toMatchObject({
      assistantMessageId: 'msg_api_1',
      contentBlockIndex: 0,
      text: 'hi',
    });
    expect(events[3]).toMatchObject({ toolUseId: 'toolu_1', toolName: 'Read' });
    expect(events[5]).toMatchObject({ toolUseId: 'toolu_1', status: 'succeeded' });
    expect(events[6]).toMatchObject({ status: 'succeeded' });
    expect(query.close).toHaveBeenCalled();
  });
});

describe('AgentSdkAdapter interruption', () => {
  it('reports a cancelled run when the interrupted query ends with an error', async () => {
    const query = {
      messages: [],
      close: vi.fn(),
      interrupt: vi.fn(async () => ({})),
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('Claude Code returned an error result');
      },
    };
    const adapter = new AgentSdkAdapter({
      queryFactory: () => query as unknown as Query,
    });
    const events: AdapterEvent[] = [];
    const handle = await adapter.startRun(
      input({ onEvent: (event) => events.push(event) }),
    );

    await handle.interrupt();

    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === 'runResult')).toBe(true);
    });
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
    expect(query.close).toHaveBeenCalled();
  });
});