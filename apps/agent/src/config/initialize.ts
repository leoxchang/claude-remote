import { chmod, mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { AgentConfig } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';
import { readJsonFileIfExists, writeFileAtomic } from './atomic-file.js';
import {
  AGENT_LISTEN_HOST,
  AGENT_LISTEN_PORT,
  CONFIG_DIR_MODE,
  CONFIG_FILE_MODE,
  resolveAgentPaths,
} from './paths.js';

/** desktopId 的随机字节数。 */
const DESKTOP_ID_BYTES = 16;

/** 初始化写入的配置。 */
export interface InitializeConfigInput {
  configDir: string;
  workspacePath: string;
  displayName: string;
  tailscaleBaseUrl: string;
}

/** 首次初始化本地配置；已有配置时拒绝覆盖。 */
export async function initializeConfig(
  input: InitializeConfigInput,
): Promise<AgentConfig> {
  const rootPath = await resolveWorkspacePath(input.workspacePath);
  const baseUrl = validateTailscaleBaseUrl(input.tailscaleBaseUrl);
  const paths = resolveAgentPaths(input.configDir);

  if ((await readJsonFileIfExists(paths.agentFile)) !== undefined) {
    throw new Error('agent.json already exists; refusing to overwrite');
  }

  const config: AgentConfig = {
    version: 1,
    desktopId: `desktop_${randomBase64Url(DESKTOP_ID_BYTES)}`,
    workspace: {
      workspaceId: 'default',
      displayName: input.displayName,
      rootPath,
    },
    listen: { host: AGENT_LISTEN_HOST, port: AGENT_LISTEN_PORT },
    tailscale: { baseUrl },
  };

  await mkdir(paths.configDir, { recursive: true, mode: CONFIG_DIR_MODE });
  await chmod(paths.configDir, CONFIG_DIR_MODE);
  await writeFileAtomic(
    paths.agentFile,
    `${JSON.stringify(config, null, 2)}\n`,
    CONFIG_FILE_MODE,
  );
  if ((await readJsonFileIfExists(paths.devicesFile)) === undefined) {
    await writeFileAtomic(
      paths.devicesFile,
      `${JSON.stringify({ version: 1, devices: [] }, null, 2)}\n`,
      CONFIG_FILE_MODE,
    );
  }

  return config;
}

async function resolveWorkspacePath(input: string): Promise<string> {
  if (!isAbsolute(input)) {
    throw new Error('workspace path must be an absolute path');
  }
  const stats = await stat(input).catch(() => undefined);
  if (stats === undefined) {
    throw new Error('workspace path does not exist');
  }
  if (!stats.isDirectory()) {
    throw new Error('workspace path is not a directory');
  }
  return realpath(input);
}

function validateTailscaleBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('tailscale base url must be a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('tailscale base url must use https');
  }
  if (!url.hostname.endsWith('.ts.net')) {
    throw new Error('tailscale base url host must end with .ts.net');
  }
  return url.origin;
}