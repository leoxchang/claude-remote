import { hostname } from 'node:os';

import { AGENT_VERSION } from '../app/versions.js';
import { readConfigV4IfExists } from '../config/config-v4.js';
import {
  AgentConfigV5,
  migrateV4ToV5,
  readConfigV5IfExists,
  RelayConfig,
  writeConfigV5AtomicSync,
} from '../config/config-v5.js';

const LOGIN_PATH = '/v1/auth/login';

/** relay 登录选项；fetchImpl 供测试注入。 */
export interface RelayLoginOptions {
  configDir: string;
  baseUrl: string;
  username: string;
  password: string;
  desktopName?: string;
  fetchImpl?: typeof fetch;
}

/** 登录成功后的设备身份。 */
export interface RelayLoginResult {
  deviceId: string;
  accountId: string;
}

interface LoginBody {
  accountId: string;
  deviceId: string;
  deviceToken: string;
}

/** 登录云端并写入 config v5 的 relay 段；失败抛稳定错误码。 */
export async function relayLogin(
  options: RelayLoginOptions,
): Promise<RelayLoginResult> {
  const config = loadWritableConfig(options.configDir);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const desktopName = options.desktopName ?? hostname();
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchImpl(`${baseUrl}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: options.username,
      password: options.password,
      clientType: 'desktop',
      deviceName: desktopName,
      platform: 'macos',
      appVersion: AGENT_VERSION,
    }),
  });
  if (response.status !== 200) {
    throw new Error(await readErrorCode(response));
  }
  const body = await readLoginBody(response);
  writeConfigV5AtomicSync(options.configDir, {
    ...config,
    relay: {
      baseUrl,
      deviceId: body.deviceId,
      deviceToken: body.deviceToken,
      desktopName,
    },
  });
  return { deviceId: body.deviceId, accountId: body.accountId };
}

/** 读取当前 relay 凭证；未配置返回 null。 */
export function readRelayConfig(configDir: string): RelayConfig | null {
  const config = readConfigV5IfExists(configDir);
  if (config === null || config.relay === undefined) return null;
  return config.relay;
}

/** 移除 relay 段（logout）；未配置时幂等。 */
export function removeRelayConfig(configDir: string): void {
  const config = readConfigV5IfExists(configDir);
  if (config === null || config.relay === undefined) return;
  const withoutRelay: AgentConfigV5 = {
    version: 5,
    desktopId: config.desktopId,
    database: config.database,
    listen: config.listen,
    tailscale: config.tailscale,
  };
  writeConfigV5AtomicSync(configDir, withoutRelay);
}

/** 云端地址归一化为 origin；只接受 http(s)。 */
function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('INVALID_CONFIG');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('INVALID_CONFIG');
  }
  return url.origin;
}

/** 读取可写配置：v5 直接可用，v4 先迁移；都缺失视为未初始化。 */
function loadWritableConfig(configDir: string): AgentConfigV5 {
  const existingV5 = readConfigV5IfExists(configDir);
  if (existingV5 !== null) return existingV5;
  const existingV4 = readConfigV4IfExists(configDir);
  if (existingV4 !== null) return migrateV4ToV5(existingV4);
  throw new Error('AGENT_NOT_INITIALIZED');
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown };
    };
    if (typeof body.error?.code === 'string') return body.error.code;
  } catch {
    // 非 JSON 错误体：退回 HTTP 状态码
  }
  return String(response.status);
}

async function readLoginBody(response: Response): Promise<LoginBody> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('INVALID_RESPONSE');
  }
  if (typeof body !== 'object' || body === null) {
    throw new Error('INVALID_RESPONSE');
  }
  const record = body as Record<string, unknown>;
  const accountId = record['accountId'];
  const deviceId = record['deviceId'];
  const deviceToken = record['deviceToken'];
  if (
    typeof accountId !== 'string' ||
    typeof deviceId !== 'string' ||
    typeof deviceToken !== 'string' ||
    deviceToken.length === 0
  ) {
    throw new Error('INVALID_RESPONSE');
  }
  return { accountId, deviceId, deviceToken };
}