import { Buffer } from 'node:buffer';

import { ApprovalContentController } from '../approval/approval-content-controller.js';
import {
  AttachmentStore,
  isImageMediaType,
  MAX_ATTACHMENT_BYTES,
} from '../attachment/attachment-store.js';
import { AgentError } from '../command/errors.js';
import { RunPromptController } from '../run/run-prompt-controller.js';

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const JSON_CONTENT_TYPE = 'application/json';

/** 内容 endpoint 的稳定状态映射（与直连路由逐字一致）。 */
const CONTENT_HTTP_STATUS: Record<string, number> = {
  INVALID_MESSAGE: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_ALREADY_RESOLVED: 409,
  APPROVAL_CONTENT_UNAVAILABLE: 409,
  APPROVAL_EXPIRED: 410,
  RATE_LIMITED: 429,
};

/** 处理器统一返回形状；直连路由与 relay 代答共用。 */
export interface HttpHandlerResult {
  status: number;
  contentType: string;
  body: Buffer;
}

/** JSON 错误体（{error:{code,message}}）。 */
export function errorResult(status: number, code: string): HttpHandlerResult {
  return {
    status,
    contentType: JSON_CONTENT_TYPE,
    body: Buffer.from(JSON.stringify({ error: { code, message: code } })),
  };
}

/** JSON 成功体。 */
export function jsonResult(status: number, value: unknown): HttpHandlerResult {
  return {
    status,
    contentType: JSON_CONTENT_TYPE,
    body: Buffer.from(JSON.stringify(value)),
  };
}

/** 只接受无符号十进制整数；拒绝负数、小数、空格与科学计数法。 */
export function parseChunkIndex(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  return Number(value);
}

interface AttachmentUpload {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Buffer;
}

/** 只接受 `{mediaType, dataBase64}`；解码后由存储层再验大小与格式。 */
export function parseAttachmentUpload(
  body: unknown,
): AttachmentUpload | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const mediaType = record['mediaType'];
  const dataBase64 = record['dataBase64'];
  if (
    !isImageMediaType(mediaType) ||
    typeof dataBase64 !== 'string' ||
    dataBase64.length === 0 ||
    !BASE64_PATTERN.test(dataBase64)
  ) {
    return null;
  }
  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) return null;
  return { mediaType, bytes };
}

/** 附件上传处理器依赖。 */
export interface AttachmentHandlerDeps {
  attachments?: AttachmentStore;
}

/** 图片附件上传：payload 为已解析 JSON 对象。 */
export function handleAttachmentUpload(
  deps: AttachmentHandlerDeps,
  input: { deviceId: string; payload: unknown },
): HttpHandlerResult {
  if (deps.attachments === undefined) {
    return errorResult(404, 'ATTACHMENT_UNAVAILABLE');
  }
  const upload = parseAttachmentUpload(input.payload);
  if (upload === null) return errorResult(400, 'INVALID_MESSAGE');
  try {
    const saved = deps.attachments.save({
      deviceId: input.deviceId,
      mediaType: upload.mediaType,
      bytes: upload.bytes,
    });
    return jsonResult(201, saved);
  } catch {
    return errorResult(400, 'INVALID_MESSAGE');
  }
}

/** 审批内容读取处理器依赖。 */
export interface ApprovalContentDeps {
  approvalContent?: ApprovalContentController;
}

/** 审批内容分块读取。 */
export function handleApprovalContentRead(
  deps: ApprovalContentDeps,
  input: {
    deviceId: string;
    approvalId: string;
    query: Record<string, unknown>;
  },
): HttpHandlerResult {
  if (deps.approvalContent === undefined) {
    return errorResult(404, 'APPROVAL_NOT_FOUND');
  }
  const chunkIndex = parseChunkIndex(input.query['chunkIndex']);
  if (input.approvalId.length === 0 || chunkIndex === null) {
    return errorResult(400, 'INVALID_MESSAGE');
  }
  try {
    const response = deps.approvalContent.readChunk({
      approvalId: input.approvalId,
      chunkIndex,
      deviceId: input.deviceId,
    });
    return jsonResult(200, response);
  } catch (error: unknown) {
    if (error instanceof AgentError) {
      return errorResult(CONTENT_HTTP_STATUS[error.code] ?? 409, error.code);
    }
    throw error;
  }
}

/** run prompt 读取处理器依赖。 */
export interface RunPromptDeps {
  runPrompt?: RunPromptController;
}

/** 认证只读 run prompt。 */
export function handleRunPromptRead(
  deps: RunPromptDeps,
  input: { deviceId: string; runId: string },
): HttpHandlerResult {
  if (deps.runPrompt === undefined) {
    return errorResult(404, 'RUN_NOT_FOUND');
  }
  if (input.runId.length === 0) return errorResult(400, 'INVALID_MESSAGE');
  try {
    const response = deps.runPrompt.read(input.runId, input.deviceId);
    return jsonResult(200, response);
  } catch (error: unknown) {
    if (error instanceof AgentError) {
      const status =
        error.code === 'FORBIDDEN'
          ? 403
          : error.code === 'RUN_NOT_RECOVERABLE'
            ? 409
            : 404;
      return errorResult(status, error.code);
    }
    throw error;
  }
}