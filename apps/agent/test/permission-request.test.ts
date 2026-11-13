import { describe, expect, it } from 'vitest';

import {
  clonePermissionInput,
  classifyPermissionTool,
  permissionRequestFingerprint,
} from '../src/approval/permission-request.js';
import { SdkPermissionRequest } from '../src/approval/approval-types.js';

function makeRequest(
  overrides: Partial<SdkPermissionRequest> = {},
): SdkPermissionRequest {
  return {
    toolName: 'Edit',
    input: {
      file_path: '/fixture/项目/example.ts',
      old_string: 'before',
      new_string: 'after',
    },
    signal: new AbortController().signal,
    toolUseID: 'toolu_01',
    requestId: 'req_01',
    ...overrides,
  };
}

describe('clonePermissionInput', () => {
  it('returns a frozen deep copy that later mutation cannot affect', () => {
    const original = {
      file_path: '/fixture/项目/example.ts',
      nested: { values: [1, 2], flag: true },
      old_string: 'before',
      new_string: 'after',
    };

    const clone = clonePermissionInput(original);
    original.nested.values.push(3);
    original.file_path = 'mutated';

    expect(clone['file_path']).toBe('/fixture/项目/example.ts');
    expect(clone['nested']).toEqual({ values: [1, 2], flag: true });
    expect(Object.isFrozen(clone)).toBe(true);
    expect(Object.isFrozen(clone['nested'])).toBe(true);
    expect(Object.isFrozen((clone['nested'] as { values: unknown[] }).values)).toBe(
      true,
    );
  });

  it('rejects prototype-mutating keys before they can reach Runtime', () => {
    const marker = {} as Record<string, unknown>;
    const protoPayload = JSON.parse(
      '{"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;

    expect(() => clonePermissionInput(protoPayload)).toThrow(
      'APPROVAL_CONTENT_UNAVAILABLE',
    );
    expect(marker['polluted']).toBeUndefined();

    for (const key of ['constructor', 'prototype']) {
      expect(() => clonePermissionInput({ [key]: { x: 1 } })).toThrow(
        'APPROVAL_CONTENT_UNAVAILABLE',
      );
    }
  });

  it('rejects values that cannot be represented safely as JSON', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;

    for (const value of [
      cycle,
      { big: 1n },
      { fn: () => undefined },
      { missing: undefined },
      { infinite: Number.POSITIVE_INFINITY },
      { nan: Number.NaN },
      { date: new Date(0) },
      { symbol: Symbol('x') },
    ]) {
      expect(() => clonePermissionInput(value)).toThrow(
        'APPROVAL_CONTENT_UNAVAILABLE',
      );
    }
  });
});

describe('classifyPermissionTool', () => {
  it('supports exactly the nine S03 tools', () => {
    for (const toolName of [
      'Bash',
      'Write',
      'Edit',
      'NotebookEdit',
      'Read',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
    ]) {
      expect(classifyPermissionTool({ toolName })).toEqual({ kind: 'supported' });
    }
  });

  it('fails closed for AskUserQuestion, MCP and unknown tools', () => {
    expect(classifyPermissionTool({ toolName: 'AskUserQuestion' })).toEqual({
      kind: 'unsupported',
      code: 'UNSUPPORTED_USER_INTERACTION',
      message: 'User interaction is not supported in S03',
    });
    expect(classifyPermissionTool({ toolName: 'mcp__server__tool' })).toMatchObject(
      { code: 'UNSUPPORTED_USER_INTERACTION' },
    );
    expect(
      classifyPermissionTool({
        toolName: 'Read',
        mcpServer: { name: 'server', source: 'project' },
      }),
    ).toMatchObject({ code: 'UNSUPPORTED_USER_INTERACTION' });
    expect(classifyPermissionTool({ toolName: 'CronCreate' })).toEqual({
      kind: 'unsupported',
      code: 'APPROVAL_TOOL_UNSUPPORTED',
      message: 'Tool is not supported for mobile approval',
    });
  });
});

describe('permissionRequestFingerprint', () => {
  it('is stable across object key order and volatile fields', () => {
    const controller = new AbortController();
    const first = makeRequest({
      input: { a: 1, b: { c: [1, 2] } },
      suggestions: [{ type: 'addRules' }],
      signal: controller.signal,
    });
    const second = makeRequest({
      input: { b: { c: [1, 2] }, a: 1 },
      suggestions: [],
      signal: new AbortController().signal,
    });

    expect(permissionRequestFingerprint(first)).toBe(
      permissionRequestFingerprint(second),
    );
  });

  it('changes when array order or any covered field changes', () => {
    const base = permissionRequestFingerprint(makeRequest());
    const variants = [
      makeRequest({ input: { values: [1, 2] } }),
      makeRequest({ input: { values: [2, 1] } }),
      makeRequest({ toolUseID: 'toolu_02' }),
      makeRequest({ agentID: 'agent_02' }),
      makeRequest({ decisionReason: 'rule' }),
      makeRequest({ defaultToNo: true }),
      makeRequest({ blockedPath: '/fixture/secret.txt' }),
      makeRequest({ mcpServer: { name: 'server', source: 'project' } }),
    ];

    for (const variant of variants) {
      expect(permissionRequestFingerprint(variant)).not.toBe(base);
    }
  });

  it('snapshots input so later mutation does not change the fingerprint', () => {
    const input = { command: 'echo S03_SECRET' };
    const request = makeRequest({
      toolName: 'Bash',
      input: clonePermissionInput(input),
    });
    const before = permissionRequestFingerprint(request);

    input.command = 'echo mutated';

    expect(permissionRequestFingerprint(request)).toBe(before);
    expect(before).not.toContain('S03_SECRET');
  });

  it('rejects input that cannot be fingerprinted without leaking content', () => {
    const bigint = makeRequest({ input: { secret: 1n } });
    expect(() => permissionRequestFingerprint(bigint)).toThrow(
      'APPROVAL_CONTENT_UNAVAILABLE',
    );
    try {
      permissionRequestFingerprint(bigint);
    } catch (error: unknown) {
      expect(String(error)).not.toContain('secret');
    }
  });
});