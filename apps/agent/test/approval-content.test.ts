import { describe, expect, it } from 'vitest';

import {
  approvalContentDescriptor,
  buildApprovalContent,
  MAX_CHUNK_BYTES,
  MAX_CONTENT_BYTES,
  MAX_CONTENT_CHUNKS,
} from '../src/approval/approval-content.js';
import { SdkPermissionRequest } from '../src/approval/approval-types.js';
import { sha256Base64Url } from '../src/security/random.js';

const WORKING_DIRECTORY = '/fixture/项目';

function makeRequest(
  input: Record<string, unknown>,
  overrides: Partial<SdkPermissionRequest> = {},
): SdkPermissionRequest {
  return {
    toolName: 'Edit',
    input,
    signal: new AbortController().signal,
    toolUseID: 'toolu_01',
    requestId: 'req_01',
    ...overrides,
  };
}

describe('buildApprovalContent', () => {
  it('recombines exact JSON without splitting UTF-8 and hides secrets in the descriptor', () => {
    const content = buildApprovalContent({
      request: makeRequest({
        file_path: `${WORKING_DIRECTORY}/例子.ts`,
        old_string: '组合字符 é before',
        new_string: 'emoji 🙂 after',
      }),
      workingDirectory: WORKING_DIRECTORY,
    });

    expect(content.chunks.join('')).toBe(content.jsonText);
    expect(content.chunks.length).toBeGreaterThan(0);
    for (const chunk of content.chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(
        MAX_CHUNK_BYTES,
      );
      expect(Buffer.from(chunk, 'utf8').toString('utf8')).toBe(chunk);
    }
    expect(sha256Base64Url(content.chunks.join(''))).toBe(content.sha256);
    expect(content.byteLength).toBe(Buffer.byteLength(content.jsonText, 'utf8'));

    const full = JSON.parse(content.jsonText) as Record<string, unknown>;
    expect(full).toMatchObject({
      toolName: 'Edit',
      workingDirectory: WORKING_DIRECTORY,
      input: {
        file_path: `${WORKING_DIRECTORY}/例子.ts`,
        old_string: '组合字符 é before',
        new_string: 'emoji 🙂 after',
      },
      context: {
        agentID: null,
        decisionReason: null,
        defaultToNo: null,
        blockedPath: null,
        mcpServer: null,
      },
    });

    const descriptor = approvalContentDescriptor(content);
    expect(Object.keys(descriptor).sort()).toEqual([
      'byteLength',
      'chunkCount',
      'encoding',
      'sha256',
    ]);
    expect(JSON.stringify(descriptor)).not.toContain(WORKING_DIRECTORY);
    expect(JSON.stringify(descriptor)).not.toContain('emoji');
  });

  it('carries optional context fields when present', () => {
    const content = buildApprovalContent({
      request: makeRequest(
        { command: 'echo S03_ALPHA' },
        {
          toolName: 'Bash',
          agentID: 'agent_01',
          decisionReason: 'Bash requires approval',
          defaultToNo: true,
          blockedPath: '/fixture/blocked.txt',
        },
      ),
      workingDirectory: WORKING_DIRECTORY,
    });

    expect(JSON.parse(content.jsonText)).toMatchObject({
      context: {
        agentID: 'agent_01',
        decisionReason: 'Bash requires approval',
        defaultToNo: true,
        blockedPath: '/fixture/blocked.txt',
        mcpServer: null,
      },
    });
  });

  it('accepts exactly 1 MiB in 32 chunks and rejects 1 MiB + 1', () => {
    const base = buildApprovalContent({
      request: makeRequest({ text: '' }),
      workingDirectory: WORKING_DIRECTORY,
    });
    const padding = MAX_CONTENT_BYTES - base.byteLength;
    expect(padding).toBeGreaterThan(0);

    const exact = buildApprovalContent({
      request: makeRequest({ text: 'a'.repeat(padding) }),
      workingDirectory: WORKING_DIRECTORY,
    });
    expect(exact.byteLength).toBe(MAX_CONTENT_BYTES);
    expect(exact.chunks).toHaveLength(MAX_CONTENT_CHUNKS);
    expect(exact.chunks.join('')).toBe(exact.jsonText);

    expect(() =>
      buildApprovalContent({
        request: makeRequest({ text: 'a'.repeat(padding + 1) }),
        workingDirectory: WORKING_DIRECTORY,
      }),
    ).toThrow('APPROVAL_CONTENT_TOO_LARGE');
  });

  it('keeps multibyte characters intact at the 32 KiB boundary', () => {
    const content = buildApprovalContent({
      request: makeRequest({ text: '中文🙂'.repeat(20_000) }),
      workingDirectory: WORKING_DIRECTORY,
    });

    expect(content.chunks.length).toBeGreaterThan(1);
    expect(content.chunks.join('')).toBe(content.jsonText);
    for (const chunk of content.chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(
        MAX_CHUNK_BYTES,
      );
    }
  });

  it('rejects unserializable input without echoing it', () => {
    expect(() =>
      buildApprovalContent({
        request: makeRequest({ secret: 1n }),
        workingDirectory: WORKING_DIRECTORY,
      }),
    ).toThrow('APPROVAL_CONTENT_UNAVAILABLE');

    try {
      buildApprovalContent({
        request: makeRequest({ 'secret-do-not-leak': 1n }),
        workingDirectory: WORKING_DIRECTORY,
      });
    } catch (error: unknown) {
      expect(String(error)).not.toContain('secret-do-not-leak');
    }
  });
});