import { createHash } from 'node:crypto';

import { AgentError } from '../command/errors.js';
import {
  ApprovalContent,
  ApprovalContentDescriptor,
  SdkPermissionRequest,
} from './approval-types.js';
import { clonePermissionInput } from './permission-request.js';

/** 单份完整内容上限：1 MiB。 */
export const MAX_CONTENT_BYTES = 1024 * 1024;

/** 单块 UTF-8 上限：32 KiB。 */
export const MAX_CHUNK_BYTES = 32 * 1024;

/** 单份内容最多块数。 */
export const MAX_CONTENT_CHUNKS = 32;

/** 构造完整审批内容：固定外层结构、不可变输入、按 code point 分块。 */
export function buildApprovalContent(input: {
  request: SdkPermissionRequest;
  workingDirectory: string;
}): ApprovalContent {
  const { request } = input;
  const payload = {
    toolName: request.toolName,
    workingDirectory: input.workingDirectory,
    input: clonePermissionInput(request.input),
    context: {
      agentID: request.agentID ?? null,
      decisionReason: request.decisionReason ?? null,
      defaultToNo: request.defaultToNo ?? null,
      blockedPath: request.blockedPath ?? null,
      mcpServer:
        request.mcpServer === undefined
          ? null
          : { name: request.mcpServer.name, source: request.mcpServer.source },
    },
  };
  let jsonText: string;
  try {
    jsonText = JSON.stringify(payload);
  } catch {
    throw new AgentError('APPROVAL_CONTENT_UNAVAILABLE');
  }
  const byteLength = Buffer.byteLength(jsonText, 'utf8');
  if (byteLength > MAX_CONTENT_BYTES) {
    throw new AgentError('APPROVAL_CONTENT_TOO_LARGE');
  }
  const chunks = chunkByCodePoint(jsonText);
  if (chunks.length > MAX_CONTENT_CHUNKS) {
    throw new AgentError('APPROVAL_CONTENT_TOO_LARGE');
  }
  return {
    encoding: 'json-utf8',
    jsonText,
    chunks: Object.freeze(chunks),
    byteLength,
    sha256: createHash('sha256')
      .update(Buffer.from(jsonText, 'utf8'))
      .digest('base64url'),
  };
}

/** 协议可公开的安全描述；不含正文。 */
export function approvalContentDescriptor(
  content: ApprovalContent,
): ApprovalContentDescriptor {
  return {
    encoding: content.encoding,
    byteLength: content.byteLength,
    sha256: content.sha256,
    chunkCount: content.chunks.length,
  };
}

/** 按 Unicode code point 累积，单个 UTF-8 字符不会被切开。 */
function chunkByCodePoint(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (currentBytes + charBytes > MAX_CHUNK_BYTES) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) chunks.push('');
  return chunks;
}