import { existsSync, readFileSync } from 'node:fs';

import { writeFileAtomicSync } from './atomic-file.js';
import { ConfigV2Error } from './config-v2.js';
import { AgentConfigV4, parseAgentConfigV4 } from './config-v4.js';
import { CONFIG_FILE_MODE, ListenHost, resolveAgentPaths } from './paths.js';

/** 云端中转凭证；写 agent.json（0600）。 */
export interface RelayConfig {
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  desktopName: string;
}

/** V5 = V4 + 可选 relay 段；其余字段仍以 V4 校验规则为准。 */
export interface AgentConfigV5 {
  version: 5;
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
  relay?: RelayConfig;
}

/** V4 → V5：字段原样保留，relay 缺省。 */
export function migrateV4ToV5(config: AgentConfigV4): AgentConfigV5 {
  return {
    version: 5,
    desktopId: config.desktopId,
    database: { ...config.database },
    listen: { ...config.listen },
    tailscale: { ...config.tailscale },
  };
}

/** 严格校验 V5：其余字段复用 V4 校验，relay 单独校验。 */
export function parseAgentConfigV5(input: unknown): AgentConfigV5 {
  if (typeof input !== 'object' || input === null) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const record = input as Record<string, unknown>;
  if (record['version'] !== 5) throw new ConfigV2Error('INVALID_CONFIG');
  const v4 = parseAgentConfigV4({ ...record, version: 4 });
  const base = migrateV4ToV5(v4);
  const relayRaw = record['relay'];
  if (relayRaw === undefined) return base;
  if (typeof relayRaw !== 'object' || relayRaw === null) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const relayRecord = relayRaw as Record<string, unknown>;
  const baseUrlRaw = relayRecord['baseUrl'];
  const deviceId = relayRecord['deviceId'];
  const deviceToken = relayRecord['deviceToken'];
  const desktopName = relayRecord['desktopName'];
  if (
    typeof baseUrlRaw !== 'string' ||
    typeof deviceId !== 'string' ||
    deviceId.length === 0 ||
    typeof deviceToken !== 'string' ||
    deviceToken.length === 0 ||
    typeof desktopName !== 'string' ||
    desktopName.length === 0
  ) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  let url: URL;
  try {
    url = new URL(baseUrlRaw);
  } catch {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  return {
    ...base,
    relay: {
      baseUrl: url.origin,
      deviceId,
      deviceToken,
      desktopName,
    },
  };
}

/** 读取 V5；文件缺失或仍是 V4 时返回 null，交由迁移处理。 */
export function readConfigV5IfExists(
  configDir: string,
): AgentConfigV5 | null {
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
    (parsed as { version?: unknown }).version !== 5
  ) {
    return null;
  }
  return parseAgentConfigV5(parsed);
}

/** 原子写 V5，权限 0600。 */
export function writeConfigV5AtomicSync(
  configDir: string,
  config: AgentConfigV5,
): void {
  const validated = parseAgentConfigV5(config);
  const paths = resolveAgentPaths(configDir);
  writeFileAtomicSync(
    paths.agentFile,
    `${JSON.stringify(validated, null, 2)}\n`,
    CONFIG_FILE_MODE,
  );
}