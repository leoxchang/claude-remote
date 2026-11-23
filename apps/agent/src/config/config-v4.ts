import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomicSync } from './atomic-file.js';
import {
  AGENT_LISTEN_HOST,
  CONFIG_FILE_MODE,
  LAN_LISTEN_HOST,
  ListenHost,
  resolveAgentPaths,
} from './paths.js';
import { ConfigV2Error } from './config-v2.js';
import { parseBaseUrl } from './base-url.js';

/** V4 只保留 bootstrap 配置；项目与设备以 SQLite 为权威。 */
export interface AgentConfigV4 {
  version: 4;
  desktopId: string;
  database: {
    file: string;
  };
  listen: {
    host: ListenHost;
    port: 8787;
  };
  tailscale: {
    baseUrl: string;
  };
}

/** 默认数据库文件名；位于 configDir 内。 */
export const DEFAULT_DATABASE_FILE = 'agent.sqlite3';

/** 严格校验 V4；缺失字段或尝试携带 workspaces/devices 一律拒绝。 */
export function parseAgentConfigV4(input: unknown): AgentConfigV4 {
  if (typeof input !== 'object' || input === null) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const record = input as Record<string, unknown>;
  if (record['version'] !== 4) throw new ConfigV2Error('INVALID_CONFIG');
  if ('workspaces' in record || 'device' in record || 'devices' in record) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const desktopId = record['desktopId'];
  if (typeof desktopId !== 'string' || desktopId.length === 0) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const database = record['database'];
  if (typeof database !== 'object' || database === null) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const file = (database as Record<string, unknown>)['file'];
  if (typeof file !== 'string' || file.length === 0 || file.includes('/')) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const listen = record['listen'];
  const tailscale = record['tailscale'];
  const listenRecord =
    typeof listen === 'object' && listen !== null
      ? (listen as Record<string, unknown>)
      : null;
  const listenHost = listenRecord?.['host'];
  if (
    listenRecord === null ||
    (listenHost !== AGENT_LISTEN_HOST && listenHost !== LAN_LISTEN_HOST) ||
    listenRecord['port'] !== 8787
  ) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  if (
    typeof tailscale !== 'object' ||
    tailscale === null ||
    typeof (tailscale as Record<string, unknown>)['baseUrl'] !== 'string'
  ) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const baseUrlRaw = (tailscale as Record<string, unknown>)['baseUrl'] as string;
  let baseUrl: URL;
  try {
    baseUrl = parseBaseUrl(baseUrlRaw);
  } catch {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  // 局域网模式只允许私有 http；隧道模式只允许 https。
  const lanMode = listenHost === LAN_LISTEN_HOST;
  if (lanMode !== (baseUrl.protocol === 'http:')) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  return {
    version: 4,
    desktopId,
    database: { file },
    listen: {
      host: lanMode ? LAN_LISTEN_HOST : AGENT_LISTEN_HOST,
      port: 8787,
    },
    tailscale: { baseUrl: baseUrl.origin },
  };
}

/** 读取 V4；文件缺失或仍是 V3 时返回 null，交由迁移处理。 */
export function readConfigV4IfExists(
  configDir: string,
): AgentConfigV4 | null {
  const paths = resolveAgentPaths(configDir);
  if (!existsSync(paths.agentFile)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.agentFile, 'utf8'));
  } catch {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 4
  ) {
    return null;
  }
  return parseAgentConfigV4(parsed);
}

/** 原子写 V4，权限 0600。 */
export function writeConfigV4AtomicSync(
  configDir: string,
  config: AgentConfigV4,
): void {
  const validated = parseAgentConfigV4(config);
  const paths = resolveAgentPaths(configDir);
  writeFileAtomicSync(
    paths.agentFile,
    `${JSON.stringify(validated, null, 2)}\n`,
    CONFIG_FILE_MODE,
  );
}

/** 数据库绝对路径；只接受 configDir 内的文件名。 */
export function resolveDatabasePath(
  configDir: string,
  config: AgentConfigV4,
): string {
  return join(configDir, config.database.file);
}