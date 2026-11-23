import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalContentController } from '../../src/approval/approval-content-controller.js';
import { AttachmentStore } from '../../src/attachment/attachment-store.js';
import { AgentError } from '../../src/command/errors.js';
import { createRelayHttpDispatch } from '../../src/relay/http-dispatch.js';
import { RunPromptController } from '../../src/run/run-prompt-controller.js';
import {
  handleApprovalContentRead,
  handleAttachmentUpload,
  handleRunPromptRead,
} from '../../src/transport/http-handlers.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

let dir: string;
let attachments: AttachmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-http-handlers-'));
  attachments = new AttachmentStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function jsonBody(buffer: Buffer): unknown {
  return JSON.parse(buffer.toString('utf8'));
}

describe('handleAttachmentUpload', () => {
  it('合法载荷 → 201 并落盘', () => {
    const result = handleAttachmentUpload(
      { attachments },
      {
        deviceId: 'dev_phone',
        payload: {
          mediaType: 'image/png',
          dataBase64: PNG_BYTES.toString('base64'),
        },
      },
    );
    expect(result.status).toBe(201);
    expect(result.contentType).toBe('application/json');
    const body = jsonBody(result.body) as { attachmentId: string };
    expect(body.attachmentId).toMatch(/^att_/);
    expect(existsSync(join(dir, 'files', `${body.attachmentId}.png`))).toBe(
      true,
    );
  });

  it('附件存储未装配 → 404 ATTACHMENT_UNAVAILABLE', () => {
    const result = handleAttachmentUpload(
      {},
      { deviceId: 'dev_phone', payload: {} },
    );
    expect(result.status).toBe(404);
    expect(jsonBody(result.body)).toEqual({
      error: { code: 'ATTACHMENT_UNAVAILABLE', message: 'ATTACHMENT_UNAVAILABLE' },
    });
  });

  it('坏载荷 → 400 INVALID_MESSAGE', () => {
    for (const payload of [
      null,
      {},
      { mediaType: 'text/plain', dataBase64: 'aGk=' },
      { mediaType: 'image/png', dataBase64: 'not base64!' },
    ]) {
      const result = handleAttachmentUpload(
        { attachments },
        { deviceId: 'dev_phone', payload },
      );
      expect(result.status).toBe(400);
    }
  });
});

describe('handleApprovalContentRead', () => {
  function stubController(): {
    controller: ApprovalContentController;
    readChunk: ReturnType<typeof vi.fn>;
  } {
    const readChunk = vi.fn(() => ({
      approvalId: 'a1',
      chunkIndex: 1,
      chunks: 2,
      content: { kind: 'text', text: 'x' },
    }));
    return {
      controller: { readChunk } as unknown as ApprovalContentController,
      readChunk,
    };
  }

  it('chunkIndex 透传，200 返回 controller 结果', () => {
    const { controller, readChunk } = stubController();
    const result = handleApprovalContentRead(
      { approvalContent: controller },
      { deviceId: 'dev_phone', approvalId: 'a1', query: { chunkIndex: '1' } },
    );
    expect(result.status).toBe(200);
    expect(readChunk).toHaveBeenCalledWith({
      approvalId: 'a1',
      chunkIndex: 1,
      deviceId: 'dev_phone',
    });
    expect(
      (jsonBody(result.body) as { approvalId: string }).approvalId,
    ).toBe('a1');
  });

  it('chunkIndex 非法 → 400 INVALID_MESSAGE', () => {
    const { controller } = stubController();
    for (const chunkIndex of [undefined, 'x', '-1', '1.5', '']) {
      const result = handleApprovalContentRead(
        { approvalContent: controller },
        {
          deviceId: 'dev_phone',
          approvalId: 'a1',
          query: chunkIndex === undefined ? {} : { chunkIndex },
        },
      );
      expect(result.status).toBe(400);
    }
  });

  it('controller 错误映射保持既有状态码', () => {
    const cases: Array<[string, number]> = [
      ['FORBIDDEN', 403],
      ['APPROVAL_NOT_FOUND', 404],
      ['APPROVAL_ALREADY_RESOLVED', 409],
      ['APPROVAL_EXPIRED', 410],
      ['RATE_LIMITED', 429],
    ];
    for (const [code, status] of cases) {
      const controller = {
        readChunk: () => {
          throw new AgentError(code as never);
        },
      } as unknown as ApprovalContentController;
      const result = handleApprovalContentRead(
        { approvalContent: controller },
        { deviceId: 'dev_phone', approvalId: 'a1', query: { chunkIndex: '0' } },
      );
      expect(result.status).toBe(status);
      expect(
        (jsonBody(result.body) as { error: { code: string } }).error.code,
      ).toBe(code);
    }
  });

  it('controller 未装配 → 404 APPROVAL_NOT_FOUND', () => {
    const result = handleApprovalContentRead(
      {},
      { deviceId: 'dev_phone', approvalId: 'a1', query: { chunkIndex: '0' } },
    );
    expect(result.status).toBe(404);
    expect(
      (jsonBody(result.body) as { error: { code: string } }).error.code,
    ).toBe('APPROVAL_NOT_FOUND');
  });
});

describe('handleRunPromptRead', () => {
  it('FORBIDDEN→403、RUN_NOT_RECOVERABLE→409、缺失→404', () => {
    const forbidden = {
      read: () => {
        throw new AgentError('FORBIDDEN');
      },
    } as unknown as RunPromptController;
    expect(
      handleRunPromptRead(
        { runPrompt: forbidden },
        { deviceId: 'dev_phone', runId: 'run_1' },
      ).status,
    ).toBe(403);

    const unrecoverable = {
      read: () => {
        throw new AgentError('RUN_NOT_RECOVERABLE');
      },
    } as unknown as RunPromptController;
    expect(
      handleRunPromptRead(
        { runPrompt: unrecoverable },
        { deviceId: 'dev_phone', runId: 'run_1' },
      ).status,
    ).toBe(409);

    const missing = {
      read: () => {
        throw new AgentError('RUN_NOT_FOUND');
      },
    } as unknown as RunPromptController;
    expect(
      handleRunPromptRead(
        { runPrompt: missing },
        { deviceId: 'dev_phone', runId: 'run_1' },
      ).status,
    ).toBe(404);

    expect(
      handleRunPromptRead({}, { deviceId: 'dev_phone', runId: 'run_1' }).status,
    ).toBe(404);
  });

  it('成功读取返回 runId 与正文', () => {
    const controller = {
      read: (runId: string) => ({ runId, text: 'hello' }),
    } as unknown as RunPromptController;
    const result = handleRunPromptRead(
      { runPrompt: controller },
      { deviceId: 'dev_phone', runId: 'run_1' },
    );
    expect(result.status).toBe(200);
    expect(jsonBody(result.body)).toEqual({ runId: 'run_1', text: 'hello' });
  });
});

describe('createRelayHttpDispatch', () => {
  it('白名单匹配与 404 ROUTE_NOT_FOUND', () => {
    const dispatch = createRelayHttpDispatch({ attachments });
    const upload = dispatch({
      deviceId: 'dev_phone',
      method: 'POST',
      path: '/v1/attachments',
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          mediaType: 'image/png',
          dataBase64: PNG_BYTES.toString('base64'),
        }),
      ),
    });
    expect(upload.status).toBe(201);

    const unknown = dispatch({
      deviceId: 'dev_phone',
      method: 'GET',
      path: '/v1/pairings',
      body: Buffer.alloc(0),
    });
    expect(unknown.status).toBe(404);
    expect(
      (jsonBody(unknown.body) as { error: { code: string } }).error.code,
    ).toBe('ROUTE_NOT_FOUND');
  });

  it('附件非 JSON contentType → 415；坏 JSON → 400', () => {
    const dispatch = createRelayHttpDispatch({ attachments });
    const wrongType = dispatch({
      deviceId: 'dev_phone',
      method: 'POST',
      path: '/v1/attachments',
      contentType: 'text/plain',
      body: Buffer.from('x'),
    });
    expect(wrongType.status).toBe(415);

    const badJson = dispatch({
      deviceId: 'dev_phone',
      method: 'POST',
      path: '/v1/attachments',
      contentType: 'application/json',
      body: Buffer.from('not-json'),
    });
    expect(badJson.status).toBe(400);
  });

  it('GET 审批内容经 query 透传 chunkIndex', () => {
    const readChunk = vi.fn(() => ({ approvalId: 'a1', chunkIndex: 0 }));
    const dispatch = createRelayHttpDispatch({
      approvalContent: { readChunk } as unknown as ApprovalContentController,
    });
    const result = dispatch({
      deviceId: 'dev_phone',
      method: 'GET',
      path: '/v1/approvals/a1/content',
      query: { chunkIndex: '0' },
      body: Buffer.alloc(0),
    });
    expect(result.status).toBe(200);
    expect(readChunk).toHaveBeenCalledWith({
      approvalId: 'a1',
      chunkIndex: 0,
      deviceId: 'dev_phone',
    });
  });
});