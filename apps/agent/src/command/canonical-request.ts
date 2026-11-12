import { createHash } from 'node:crypto';

import { JsonObject, JsonValue } from '../domain/types.js';

/** 幂等判定所需的命令身份；不含原始 payload 之外的任何内容。 */
export interface CommandIdentity {
  commandId: string;
  type: string;
  workspaceId?: string;
  sessionId?: string;
  runId?: string;
  approvalId?: string;
  payload: JsonObject;
}

/**
 * 规范化请求的 SHA-256 指纹。
 *
 * 对象 key 排序，数组保持顺序与内容，输出 base64url。
 */
export function canonicalRequestFingerprint(identity: CommandIdentity): string {
  const canonical = canonicalJson({
    type: identity.type,
    workspaceId: identity.workspaceId ?? null,
    sessionId: identity.sessionId ?? null,
    runId: identity.runId ?? null,
    approvalId: identity.approvalId ?? null,
    payload: identity.payload,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`);
  return `{${entries.join(',')}}`;
}