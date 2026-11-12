import { AgentError } from '../command/errors.js';
import { JsonObject, JsonValue } from '../domain/types.js';
import { sha256Base64Url } from '../security/random.js';
import {
  PermissionToolClassification,
  SdkPermissionRequest,
  SUPPORTED_APPROVAL_TOOLS,
  UNSUPPORTED_INTERACTION_MESSAGE,
  UNSUPPORTED_INTERACTION_TOOL,
} from './approval-types.js';

/** 克隆允许的最大嵌套深度；超过视为不可安全序列化。 */
const MAX_CLONE_DEPTH = 32;

/** 严格克隆 SDK 输入为不可变 JSON；拒绝任何不可 JSON 序列化的值。 */
export function clonePermissionInput(
  input: Record<string, unknown>,
): Record<string, JsonValue> {
  const clone = cloneValue(input, new Set<object>(), 0);
  if (!isJsonObject(clone)) {
    throw new AgentError('APPROVAL_CONTENT_UNAVAILABLE');
  }
  return clone;
}

/** 按固定工具集合分类；MCP、结构化交互与未知工具全部 fail closed。 */
export function classifyPermissionTool(
  request: Pick<SdkPermissionRequest, 'toolName'> &
    Partial<Pick<SdkPermissionRequest, 'mcpServer'>>,
): PermissionToolClassification {
  if (
    request.toolName === UNSUPPORTED_INTERACTION_TOOL ||
    request.toolName.startsWith('mcp__') ||
    request.mcpServer !== undefined
  ) {
    return {
      kind: 'unsupported',
      code: 'UNSUPPORTED_USER_INTERACTION',
      message: UNSUPPORTED_INTERACTION_MESSAGE,
    };
  }
  if (!SUPPORTED_APPROVAL_TOOLS.has(request.toolName)) {
    return {
      kind: 'unsupported',
      code: 'APPROVAL_TOOL_UNSUPPORTED',
      message: 'Tool is not supported for mobile approval',
    };
  }
  return { kind: 'supported' };
}

/**
 * 规范化请求指纹。
 *
 * 覆盖 toolName/input/toolUseID/agentID/decisionReason/defaultToNo/
 * blockedPath/mcpServer；不包含 signal 与 suggestions。
 */
export function permissionRequestFingerprint(
  request: SdkPermissionRequest,
): string {
  const snapshot: JsonObject = {
    toolName: request.toolName,
    input: clonePermissionInput(request.input),
    toolUseID: request.toolUseID,
    agentID: request.agentID ?? null,
    decisionReason: request.decisionReason ?? null,
    defaultToNo: request.defaultToNo ?? null,
    blockedPath: request.blockedPath ?? null,
    mcpServer:
      request.mcpServer === undefined
        ? null
        : { name: request.mcpServer.name, source: request.mcpServer.source },
  };
  return sha256Base64Url(canonicalJson(snapshot));
}

function cloneValue(
  value: unknown,
  seen: Set<object>,
  depth: number,
): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AgentError('APPROVAL_CONTENT_UNAVAILABLE');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new AgentError('APPROVAL_CONTENT_UNAVAILABLE');
  }
  if (depth >= MAX_CLONE_DEPTH || seen.has(value)) {
    throw new AgentError('APPROVAL_CONTENT_UNAVAILABLE');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const cloned: JsonValue[] = value.map((entry) =>
        cloneValue(entry, seen, depth + 1),
      );
      Object.freeze(cloned);
      return cloned;
    }
    if (!isPlainObject(value)) {
      throw new AgentError('APPROVAL_CONTENT_UNAVAILABLE');
    }
    const cloned: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      cloned[key] = cloneValue(value[key], seen, depth + 1);
    }
    Object.freeze(cloned);
    return cloned;
  } finally {
    seen.delete(value);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`;
}