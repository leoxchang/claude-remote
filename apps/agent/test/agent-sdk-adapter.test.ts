import { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { AgentSdkAdapter, QueryFactoryParams } from '../src/adapter/agent-sdk-adapter.js';
import {
  ManagedRunStart,
  PermissionGate,
} from '../src/adapter/managed-run-driver.js';
import {
  PermissionResult,
  SdkPermissionRequest,
} from '../src/approval/approval-types.js';
import { AdapterEvent } from '../src/events/adapter-events.js';
import { denyAllPermissionGate } from './permission-gate-fakes.js';

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

const input = (overrides: Partial<ManagedRunStart> = {}): ManagedRunStart => ({
  sessionId: 'session_01',
  workspaceId: 'ws_alpha',
  claudeSessionId: null,
  runId: 'run_01',
  adapterGeneration: 1,
  text: 'hello',
  cwd: '/tmp/s01-fixture',
  deviceId: 'device_1',
  permissionBroker: denyAllPermissionGate(),
  onEvent: () => undefined,
  ...overrides,
});

/** 启动并立即释放缓冲事件；S01 用例只关心映射结果。 */
function start(adapter: AgentSdkAdapter, startInput: ManagedRunStart) {
  const handle = adapter.startRun(startInput);
  handle.resumeEvents();
  return handle;
}

describe('AgentSdkAdapter options', () => {
  it('uses the S00 verified presets, settings and cwd', async () => {
    const { adapter, calls } = adapterWith([]);

    start(adapter, input());

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

    start(adapter, input());

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
    start(adapter, input());
    start(adapter, input({ claudeSessionId: 'claude_01' }));

    expect(calls[0]?.options.resume).toBeUndefined();
    expect(calls[1]?.options.resume).toBe('claude_01');
  });

  it('delegates permission requests to the injected gate without wrapping', async () => {
    let resolveResult: (result: PermissionResult) => void = () => undefined;
    const shared = new Promise<PermissionResult>((resolve) => {
      resolveResult = resolve;
    });
    const seen: Array<{ runId: string; request: SdkPermissionRequest }> = [];
    const gate: PermissionGate = {
      request: (runId, request) => {
        seen.push({ runId, request });
        return shared;
      },
    };
    const { adapter, calls } = adapterWith([]);
    start(adapter, input({ permissionBroker: gate }));
    const options = {
      signal: new AbortController().signal,
      requestId: 'req_1',
      toolUseID: 'toolu_1',
    } as never;

    const first = calls[0]?.options.canUseTool?.(
      'Bash',
      { command: 'printf hi' },
      options,
    );
    const second = calls[0]?.options.canUseTool?.(
      'Bash',
      { command: 'printf hi' },
      options,
    );

    expect(first).toBe(second);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.runId).toBe('run_01');
    expect(seen[0]?.request).toMatchObject({
      toolName: 'Bash',
      requestId: 'req_1',
      toolUseID: 'toolu_1',
      input: { command: 'printf hi' },
    });
    resolveResult({
      behavior: 'deny',
      message: 'default policy denies',
      interrupt: false,
      toolUseID: 'toolu_1',
    });
    await expect(first).resolves.toEqual({
      behavior: 'deny',
      message: 'default policy denies',
      interrupt: false,
      toolUseID: 'toolu_1',
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

    start(adapter, input({ onEvent: (event) => events.push(event) }));
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
    const handle = start(
      adapter,
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
describe('AgentSdkAdapter edge mapping', () => {
  it('reports a failed run when the query throws without interruption', async () => {
    const query = {
      close: vi.fn(),
      interrupt: vi.fn(),
      async *[Symbol.asyncIterator]() {
        throw new Error('boom');
      },
    };
    const adapter = new AgentSdkAdapter({
      queryFactory: () => query as unknown as Query,
    });
    const events: AdapterEvent[] = [];

    start(adapter, input({ onEvent: (event) => events.push(event) }));
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === 'runResult')).toBe(true);
    });
    expect(events.at(-1)).toMatchObject({
      status: 'failed',
      errorSummary: 'sdk reported an error',
    });
  });

  it('maps a user string content and a text-only assistant message', async () => {
    const { adapter, calls } = adapterWith([
      { type: 'user', session_id: 'claude_01', message: { content: 'plain' } },
      {
        type: 'assistant',
        session_id: 'claude_01',
        message: { id: 'msg_2', content: [{ type: 'text', text: 'done' }] },
      },
      { type: 'result', subtype: 'error_max_turns', session_id: 'claude_01' },
    ]);
    const events: AdapterEvent[] = [];

    start(adapter, input({ onEvent: (event) => events.push(event) }));
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === 'runResult')).toBe(true);
    });

    expect(events.map((event) => event.kind)).toEqual([
      'assistantCompleted',
      'runResult',
    ]);
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
    expect(calls[0]?.options.resume).toBeUndefined();
  });

  it('joins tool result text blocks and marks failed results', async () => {
    const { adapter } = adapterWith([
      {
        type: 'user',
        session_id: 'claude_01',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_9',
              content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
              is_error: true,
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', session_id: 'claude_01' },
    ]);
    const events: AdapterEvent[] = [];

    start(adapter, input({ onEvent: (event) => events.push(event) }));
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === 'runResult')).toBe(true);
    });

    const completed = events.find((event) => event.kind === 'toolCompleted');
    expect(completed).toMatchObject({
      toolUseId: 'toolu_9',
      status: 'failed',
      isError: true,
    });
    const output = events.find((event) => event.kind === 'toolOutput');
    expect(output).toMatchObject({ text: 'ab' });
  });
});

describe('AgentSdkAdapter tool denial', () => {
  it('does not install a PreToolUse deny hook in S03', () => {
    const { adapter, calls } = adapterWith([]);

    start(adapter, input());

    expect(calls[0]?.options.hooks).toBeUndefined();
    expect(calls[0]?.options.permissionMode).toBe('default');
  });
});
