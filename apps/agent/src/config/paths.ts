import { homedir } from 'node:os';
import { join } from 'node:path';

/** 默认配置目录；测试必须注入临时目录。 */
export const DEFAULT_CONFIG_DIR = join(homedir(), '.claude-remote');

/** 配置目录权限：仅当前用户可进入。 */
export const CONFIG_DIR_MODE = 0o700;

/** 配置文件权限：仅当前用户可读写。 */
export const CONFIG_FILE_MODE = 0o600;

/** 监听地址固定为 localhost。 */
export const AGENT_LISTEN_HOST = '127.0.0.1' as const;

/** 局域网直连模式的监听地址。 */
export const LAN_LISTEN_HOST = '0.0.0.0' as const;

/** 监听端口固定为 8787。 */
export const AGENT_LISTEN_PORT = 8787 as const;

/** 允许的监听地址：回环或全部接口（仅局域网模式）。 */
export type ListenHost = typeof AGENT_LISTEN_HOST | typeof LAN_LISTEN_HOST;

/** 一个配置目录下的全部固定路径。 */
export interface AgentPaths {
  configDir: string;
  agentFile: string;
  devicesFile: string;
  socketPath: string;
  logFile: string;
}

/** 解析配置目录下的固定文件路径。 */
export function resolveAgentPaths(
  configDir: string = DEFAULT_CONFIG_DIR,
): AgentPaths {
  return {
    configDir,
    agentFile: join(configDir, 'agent.json'),
    devicesFile: join(configDir, 'devices.json'),
    socketPath: join(configDir, 'agent.sock'),
    logFile: join(configDir, 'agent.log'),
  };
}