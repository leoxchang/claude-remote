import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { AgentError } from '../command/errors.js';
import { AgentConfigV2 } from '../domain/types.js';
import {
  DEFAULT_PER_SESSION_QUEUE_LIMIT,
  MAX_PER_SESSION_QUEUE_LIMIT,
  MAX_WORKSPACES,
  MIN_PER_SESSION_QUEUE_LIMIT,
  WorkspaceRecord,
} from '../workspace/workspace-types.js';
import {
  readJsonFileIfExists,
  writeFileAtomic,
  writeFileAtomicSync,
} from './atomic-file.js';
import {
  AGENT_LISTEN_HOST,
  AGENT_LISTEN_PORT,
  CONFIG_FILE_MODE,
  DEFAULT_CONFIG_DIR,
  resolveAgentPaths,
} from './paths.js';

/** 显示名允许的最大 Unicode code point 数。 */
export const MAX_DISPLAY_NAME_CODE_POINTS = 80;

/** 配置 V2 的结构性错误；消息只包含稳定 code。 */
export class ConfigV2Error extends Error {
  constructor(
    readonly code: 'INVALID_CONFIG' | 'TOO_MANY_WORKSPACES',
    message: string = code,
  ) {
    super(message);
    this.name = 'ConfigV2Error';
  }
}

/** 校验并规范化显示名：去空白后 1–80 个 code point，无控制字符。 */
export function validateDisplayName(value: string): string {
  const trimmed = value.trim();
  const points = [...trimmed];
  if (points.length === 0 || points.length > MAX_DISPLAY_NAME_CODE_POINTS) {
    throw new AgentError('INVALID_MESSAGE');
  }
  if (hasControlCharacter(trimmed)) {
    throw new AgentError('INVALID_MESSAGE');
  }
  return trimmed;
}

/** 把 V1 单项目配置迁移为 V2；已经是 V2 时按 V2 校验。 */
export function migrateConfigV1ToV2(input: unknown): AgentConfigV2 {
  const record = asRecord(input);
  if (record['version'] === 2) {
    return parseAgentConfigV2(record);
  }
  if (record['version'] !== 1) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const legacy = asRecord(record['workspace']);
  if (legacy['workspaceId'] !== 'default') {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  return {
    version: 2,
    desktopId: requireString(record, 'desktopId'),
    workspaces: [
      {
        workspaceId: 'default',
        displayName: validateDisplayName(requireString(legacy, 'displayName')),
        rootPath: requireAbsolutePath(legacy),
        createdAt: Date.now(),
        policy: { perSessionQueueLimit: DEFAULT_PER_SESSION_QUEUE_LIMIT },
      },
    ],
    listen: parseListen(record),
    tailscale: parseTailscale(record),
  };
}

/** 读取并迁移本机配置；文件缺失时报错，不创建空配置。 */
export async function loadConfigV2(
  configDir: string = DEFAULT_CONFIG_DIR,
): Promise<AgentConfigV2> {
  const paths = resolveAgentPaths(configDir);
  const raw = await readJsonFileIfExists(paths.agentFile);
  if (raw === undefined) {
    throw new Error('agent.json not found; run init first');
  }
  return migrateConfigV1ToV2(raw);
}

/** 严格校验 V2 配置；返回新的不可共享对象。 */
export function parseAgentConfigV2(input: unknown): AgentConfigV2 {
  const record = asRecord(input);
  if (record['version'] !== 2) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const rawWorkspaces = record['workspaces'];
  if (!Array.isArray(rawWorkspaces)) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  if (rawWorkspaces.length > MAX_WORKSPACES) {
    throw new ConfigV2Error('TOO_MANY_WORKSPACES');
  }
  const workspaces: WorkspaceRecord[] = [];
  const seenIds = new Set<string>();
  for (const entry of rawWorkspaces) {
    const workspace = parseWorkspace(entry);
    if (seenIds.has(workspace.workspaceId)) {
      throw new ConfigV2Error('INVALID_CONFIG');
    }
    seenIds.add(workspace.workspaceId);
    workspaces.push(workspace);
  }
  return {
    version: 2,
    desktopId: requireString(record, 'desktopId'),
    workspaces,
    listen: parseListen(record),
    tailscale: parseTailscale(record),
  };
}

/** 原子写入 V2 配置；首次替换前保留 0600 的 agent.json.v1.bak。 */
export async function writeConfigV2Atomic(
  configDir: string,
  config: AgentConfigV2,
): Promise<void> {
  const validated = parseAgentConfigV2(config);
  const paths = resolveAgentPaths(configDir);
  await backupPreviousConfig(paths.agentFile);
  await writeFileAtomic(paths.agentFile, serialize(validated), CONFIG_FILE_MODE);
}

/** 同步原子写入；供同一调用栈内完成的配置变更使用。 */
export function writeConfigV2AtomicSync(
  configDir: string,
  config: AgentConfigV2,
): void {
  const validated = parseAgentConfigV2(config);
  const paths = resolveAgentPaths(configDir);
  if (!existsSync(backupPath(paths.agentFile)) && existsSync(paths.agentFile)) {
    writeFileAtomicSync(
      backupPath(paths.agentFile),
      readFileSync(paths.agentFile, 'utf8'),
      CONFIG_FILE_MODE,
    );
  }
  writeFileAtomicSync(paths.agentFile, serialize(validated), CONFIG_FILE_MODE);
}

function parseWorkspace(input: unknown): WorkspaceRecord {
  const record = asRecord(input);
  const policy = optionalRecord(record['policy']);
  const limit = policy['perSessionQueueLimit'] ?? DEFAULT_PER_SESSION_QUEUE_LIMIT;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < MIN_PER_SESSION_QUEUE_LIMIT ||
    limit > MAX_PER_SESSION_QUEUE_LIMIT
  ) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const createdAt = record['createdAt'];
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  return {
    workspaceId: requireString(record, 'workspaceId'),
    displayName: validateDisplayName(requireString(record, 'displayName')),
    rootPath: requireAbsolutePath(record),
    createdAt,
    policy: { perSessionQueueLimit: limit },
  };
}

function parseListen(record: Record<string, unknown>): AgentConfigV2['listen'] {
  const listen = asRecord(record['listen']);
  if (
    listen['host'] !== AGENT_LISTEN_HOST ||
    listen['port'] !== AGENT_LISTEN_PORT
  ) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  return { host: AGENT_LISTEN_HOST, port: AGENT_LISTEN_PORT };
}

function parseTailscale(
  record: Record<string, unknown>,
): AgentConfigV2['tailscale'] {
  const tailscale = asRecord(record['tailscale']);
  const baseUrl = requireString(tailscale, 'baseUrl');
  if (!baseUrl.startsWith('https://') || !new URL(baseUrl).hostname.endsWith('.ts.net')) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  return { baseUrl };
}

async function backupPreviousConfig(agentFile: string): Promise<void> {
  const backup = backupPath(agentFile);
  if (existsSync(backup) || !existsSync(agentFile)) return;
  const raw = await readFile(agentFile, 'utf8');
  await writeFileAtomic(backup, raw, CONFIG_FILE_MODE);
}

function backupPath(agentFile: string): string {
  return `${agentFile}.v1.bak`;
}

function serialize(config: AgentConfigV2): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function requireAbsolutePath(record: Record<string, unknown>): string {
  const value = requireString(record, 'rootPath');
  if (!isAbsolute(value)) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  return asRecord(value);
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}