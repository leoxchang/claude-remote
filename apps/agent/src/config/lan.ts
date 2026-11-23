import { readFile } from 'node:fs/promises';
import { NetworkInterfaceInfo, networkInterfaces } from 'node:os';

import { writeFileAtomic } from './atomic-file.js';
import { parseBaseUrl } from './base-url.js';
import {
  AgentConfigV4,
  readConfigV4IfExists,
  writeConfigV4AtomicSync,
} from './config-v4.js';
import {
  AGENT_LISTEN_HOST,
  AGENT_LISTEN_PORT,
  CONFIG_FILE_MODE,
  LAN_LISTEN_HOST,
  resolveAgentPaths,
} from './paths.js';

/** 局域网切换选项；测试可注入网卡与地址。 */
export interface LanEnableOptions {
  lanAddress?: string;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
}

/** 局域网切换结果。 */
export interface LanEnableResult {
  baseUrl: string;
  listen: { host: string; port: number };
  backupPath: string;
}

/** 局域网状态。 */
export interface LanStatus {
  mode: 'lan' | 'tunnel' | 'unmigrated';
  baseUrl: string | null;
  listen: { host: string; port: number } | null;
  lanAddress: string | null;
}

/** 选取首选网卡上的非内部 IPv4；没有则返回 null。 */
export function detectLanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  const preferredNames = ['en0', 'en1'];
  const available = Object.keys(interfaces);
  const ordered = [
    ...preferredNames.filter((name) => available.includes(name)),
    ...available
      .filter((name) => !preferredNames.includes(name))
      .sort((left, right) => left.localeCompare(right)),
  ];
  for (const name of ordered) {
    for (const info of interfaces[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      return info.address;
    }
  }
  return null;
}

/** 读取当前配置的接入模式；配置未迁移时返回 unmigrated。 */
export function lanStatus(configDir: string): LanStatus {
  const config = readConfigV4IfExists(configDir);
  const lanAddress = detectLanAddress();
  if (config === null) {
    return { mode: 'unmigrated', baseUrl: null, listen: null, lanAddress };
  }
  return {
    mode: config.listen.host === LAN_LISTEN_HOST ? 'lan' : 'tunnel',
    baseUrl: config.tailscale.baseUrl,
    listen: config.listen,
    lanAddress,
  };
}

/** 切换为局域网直连：监听 0.0.0.0，baseUrl 使用私有 http。 */
export async function enableLan(
  configDir: string,
  options: LanEnableOptions = {},
): Promise<LanEnableResult> {
  const config = requireV4Config(configDir);
  const address = options.lanAddress ?? detectLanAddress(options.interfaces);
  if (address === null) {
    throw new Error('no private IPv4 address found; connect to Wi-Fi first');
  }
  const baseUrl = `http://${address}:${AGENT_LISTEN_PORT}`;
  const backupPath = await backupConfig(configDir, config);
  const next: AgentConfigV4 = {
    ...config,
    listen: { host: LAN_LISTEN_HOST, port: AGENT_LISTEN_PORT },
    tailscale: { baseUrl },
  };
  writeConfigV4AtomicSync(configDir, next);
  return { baseUrl, listen: next.listen, backupPath };
}

/** 切回隧道模式：监听 127.0.0.1，baseUrl 必须为 https。 */
export function disableLan(
  configDir: string,
  rawBaseUrl: string,
): LanEnableResult {
  const config = requireV4Config(configDir);
  const url = parseBaseUrl(rawBaseUrl);
  if (url.protocol !== 'https:') {
    throw new Error('disable requires an https base url');
  }
  const next: AgentConfigV4 = {
    ...config,
    listen: { host: AGENT_LISTEN_HOST, port: AGENT_LISTEN_PORT },
    tailscale: { baseUrl: url.origin },
  };
  writeConfigV4AtomicSync(configDir, next);
  return { baseUrl: url.origin, listen: next.listen, backupPath: '' };
}

function requireV4Config(configDir: string): AgentConfigV4 {
  const config = readConfigV4IfExists(configDir);
  if (config === null) {
    throw new Error('agent.json is not V4 yet; start the agent once to migrate');
  }
  return config;
}

async function backupConfig(
  configDir: string,
  config: AgentConfigV4,
): Promise<string> {
  const paths = resolveAgentPaths(configDir);
  const backupPath = `${paths.agentFile}.lan.bak`;
  const raw = await readFile(paths.agentFile, 'utf8').catch(() =>
    `${JSON.stringify(config, null, 2)}\n`,
  );
  await writeFileAtomic(backupPath, raw, CONFIG_FILE_MODE);
  return backupPath;
}