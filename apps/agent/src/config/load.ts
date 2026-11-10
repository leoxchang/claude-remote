import { AgentConfig } from '../domain/types.js';
import { readJsonFileIfExists } from './atomic-file.js';
import {
  AGENT_LISTEN_HOST,
  AGENT_LISTEN_PORT,
  DEFAULT_CONFIG_DIR,
  resolveAgentPaths,
} from './paths.js';

/** 读取并校验本地配置。 */
export async function loadConfig(
  configDir: string = DEFAULT_CONFIG_DIR,
): Promise<AgentConfig> {
  const paths = resolveAgentPaths(configDir);
  const raw = await readJsonFileIfExists(paths.agentFile);
  if (raw === undefined) {
    throw new Error('agent.json not found; run init first');
  }
  return parseAgentConfig(raw);
}

/** 严格校验 agent.json 的结构，拒绝任何会破坏固定边界的值。 */
export function parseAgentConfig(raw: unknown): AgentConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('agent.json must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  if (record['version'] !== 1) {
    throw new Error('agent.json version must be 1');
  }
  const desktopId = requireString(record, 'desktopId');
  const workspace = requireRecord(record, 'workspace');
  const listen = requireRecord(record, 'listen');
  const tailscale = requireRecord(record, 'tailscale');

  if (workspace['workspaceId'] !== 'default') {
    throw new Error('agent.json workspace.workspaceId must be default');
  }
  const displayName = requireString(workspace, 'displayName');
  const rootPath = requireString(workspace, 'rootPath');
  if (listen['host'] !== AGENT_LISTEN_HOST) {
    throw new Error(
      `agent.json listen.host must be ${AGENT_LISTEN_HOST}`,
    );
  }
  if (listen['port'] !== AGENT_LISTEN_PORT) {
    throw new Error(`agent.json listen.port must be ${AGENT_LISTEN_PORT}`);
  }
  const baseUrl = requireString(tailscale, 'baseUrl');
  if (!baseUrl.startsWith('https://')) {
    throw new Error('agent.json tailscale.baseUrl must use https');
  }

  return {
    version: 1,
    desktopId,
    workspace: { workspaceId: 'default', displayName, rootPath },
    listen: { host: AGENT_LISTEN_HOST, port: AGENT_LISTEN_PORT },
    tailscale: { baseUrl },
  };
}

function requireRecord(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = source[key];
  if (typeof value !== 'object' || value === null) {
    throw new Error(`agent.json ${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`agent.json ${key} must be a non-empty string`);
  }
  return value;
}