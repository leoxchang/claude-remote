import { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentSdkAdapter,
  QueryFactoryParams,
} from '../src/adapter/agent-sdk-adapter.js';
import {
  ManagedRunStart,
  PermissionGate,
} from '../src/adapter/managed-run-driver.js';
import {
  PermissionResult,
  SdkPermissionRequest,
} from '../src/approval/approval-types.js';

interface FakeQuery {
  close: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage>;
}

function idleQuery(): FakeQuery {
  return {
    close: vi.fn(),
    interrupt: vi.fn(async () => ({})),
    async *[Symbol.asyncIterator]() {
      await new Promise(() => undefined);
    },
  };
}

function startInput(
  gate: PermissionGate,
  overrides: Partial<ManagedRunStart> = {},
): ManagedRunStart {
  return {
    sessionId: 'session_01',
    workspaceId: 'ws_alpha',
    claudeSessionId: null,
    runId: 'run_01',
    adapterGeneration: 2,
    text: 'hello',
    cwd: '/tmp/s03-fixture',
    deviceId: 'device_1',
    permissionBroker: gate,
    onEvent: () => undefined,
    ...overrides,
  };
}

function adapterWith(): {
  adapter: AgentSdkAdapter;
  calls: QueryFactoryParams[];
} {
  const query = idleQuery();
  const calls: QueryFactoryParams[] = [];
  const adapter = new AgentSdkAdapter({
    queryFactory: (params) => {
      calls.push(params);
      return query as unknown as Query;
    },
  });
  return { adapter, calls };
}

const callbackSignal = new AbortController().signal;

const callbackOptions = {
  signal: callbackSignal,
  requestId: 'req_01',
  toolUseID: 'toolu_01',
  agentID: 'agent_01',
  decisionReason: 'Bash requires approval',
  defaultToNo: true,
  blockedPath: '/fixture/blocked.txt',
  suggestions: [{ type: 'addRules' }],
} as never;

describe('AgentSdkAdapter S03 wiring', () => {
  it('keeps the default mode and preset options while removing the deny hook', () => {
    const gate: PermissionGate = {
      request: () => Promise.resolve({
        behavior: 'deny',
        message: 'denied',
        interrupt: false,
        toolUseID: 'toolu_01',
      }),
    };
    const { adapter, calls } = adapterWith();

    adapter.startRun(startInput(gate));

    expect(calls[0]?.options).toMatchObject({
      cwd: '/tmp/s03-fixture',
      permissionMode: 'default',
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
    });
    expect(calls[0]?.options.hooks).toBeUndefined();
  });

  it('maps the SDK callback into a local request and returns the gate result verbatim', async () => {
    const seen: Array<{ runId: string; request: SdkPermissionRequest }> = [];
    const allowed: PermissionResult = {
      behavior: 'allow',
      updatedInput: { command: 'printf hi' },
      toolUseID: 'toolu_01',
    };
    const gate: PermissionGate = {
      request: (runId, request) => {
        seen.push({ runId, request });
        return Promise.resolve(allowed);
      },
    };
    const { adapter, calls } = adapterWith();
    adapter.startRun(startInput(gate));

    const result = await calls[0]?.options.canUseTool?.(
      'Bash',
      { command: 'printf hi' },
      callbackOptions,
    );

    expect(result).toBe(allowed);
    expect(Object.keys(result ?? {}).sort()).toEqual([
      'behavior',
      'toolUseID',
      'updatedInput',
    ]);
    expect(seen[0]?.runId).toBe('run_01');
    expect(seen[0]?.request).toMatchObject({
      toolName: 'Bash',
      input: { command: 'printf hi' },
      requestId: 'req_01',
      toolUseID: 'toolu_01',
      agentID: 'agent_01',
      decisionReason: 'Bash requires approval',
      defaultToNo: true,
      blockedPath: '/fixture/blocked.txt',
      suggestions: [{ type: 'addRules' }],
    });
    expect(seen[0]?.request.signal).toBe(callbackSignal);
  });

  it('never adds updatedPermissions, suggestions or mode changes to a denial', async () => {
    const denied: PermissionResult = {
      behavior: 'deny',
      message: 'user denied',
      interrupt: false,
      toolUseID: 'toolu_01',
    };
    const gate: PermissionGate = {
      request: () => Promise.resolve(denied),
    };
    const { adapter, calls } = adapterWith();
    adapter.startRun(startInput(gate));

    const result = await calls[0]?.options.canUseTool?.(
      'Bash',
      { command: 'printf hi' },
      callbackOptions,
    );

    expect(result).toBe(denied);
    expect(Object.keys(result ?? {}).sort()).toEqual([
      'behavior',
      'interrupt',
      'message',
      'toolUseID',
    ]);
  });
});