import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { AgentConfigV2 } from '../domain/types.js';
import {
  DEFAULT_MOBILE_APPROVAL_MODE,
  MOBILE_APPROVAL_MODES,
  MobileApprovalMode,
  WorkspaceRecord,
} from '../workspace/workspace-types.js';
import {
  readJsonFileIfExists,
  writeFileAtomic,
  writeFileAtomicSync,
} from './atomic-file.js';
import {
  ConfigV2Error,
  migrateConfigV1ToV2,
  parseAgentConfigV2,
} from './config-v2.js';
import { CONFIG_FILE_MODE, DEFAULT_CONFIG_DIR, resolveAgentPaths } from './paths.js';

/** S03 配置结构：多项目 + 队列策略 + 逐项目手机审批模式。 */
export interface AgentConfigV3 {
  version: 3;
  desktopId: string;
  workspaces: WorkspaceRecord[];
  listen: {
    host: '127.0.0.1';
    port: 8787;
  };
  tailscale: {
    baseUrl: string;
  };
}

/** V3 迁移与写盘使用的备份文件后缀。 */
export const V2_BACKUP_SUFFIX = '.v2.bak';

/** 判断值是否为合法审批模式。 */
export function isMobileApprovalMode(value: unknown): value is MobileApprovalMode {
  return (
    typeof value === 'string' &&
    MOBILE_APPROVAL_MODES.some((mode) => mode === value)
  );
}

/**
 * 把 V1/V2 配置迁移为 V3。
 *
 * 每个项目都补 `mobileApprovalMode:'deny'`，保留 queueLimit、ID 与其余字段；
 * 已经是 V3 时按 V3 严格校验。迁移不隐式扩大任何项目权限。
 */
export function migrateConfigV2ToV3(input: unknown): AgentConfigV3 {
  const record = asRecord(input);
  if (record['version'] === 3) {
    return parseAgentConfigV3(record);
  }
  const v2: AgentConfigV2 = migrateConfigV1ToV2(record);
  return {
    version: 3,
    desktopId: v2.desktopId,
    workspaces: v2.workspaces.map((workspace) => ({
      ...workspace,
      policy: {
        perSessionQueueLimit: workspace.policy.perSessionQueueLimit,
        mobileApprovalMode: DEFAULT_MOBILE_APPROVAL_MODE,
      },
    })),
    listen: v2.listen,
    tailscale: v2.tailscale,
  };
}

/** 严格校验 V3 配置；缺失或非法审批模式一律拒绝。 */
export function parseAgentConfigV3(input: unknown): AgentConfigV3 {
  const record = asRecord(input);
  if (record['version'] !== 3) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const rawWorkspaces = record['workspaces'];
  if (!Array.isArray(rawWorkspaces)) {
    throw new ConfigV2Error('INVALID_CONFIG');
  }
  const v2 = parseAgentConfigV2({ ...record, version: 2 });
  const workspaces = v2.workspaces.map((workspace, index) => {
    const raw = asRecord(rawWorkspaces[index]);
    const policy = optionalRecord(raw['policy']);
    const mode = policy['mobileApprovalMode'];
    if (!isMobileApprovalMode(mode)) {
      throw new ConfigV2Error('INVALID_CONFIG');
    }
    return {
      ...workspace,
      policy: {
        perSessionQueueLimit: workspace.policy.perSessionQueueLimit,
        mobileApprovalMode: mode,
      },
    };
  });
  return {
    version: 3,
    desktopId: v2.desktopId,
    workspaces,
    listen: v2.listen,
    tailscale: v2.tailscale,
  };
}

/** 读取并迁移本机配置；文件缺失时报错，不创建空配置。 */
export async function loadConfigV3(
  configDir: string = DEFAULT_CONFIG_DIR,
): Promise<AgentConfigV3> {
  const paths = resolveAgentPaths(configDir);
  const raw = await readJsonFileIfExists(paths.agentFile);
  if (raw === undefined) {
    throw new Error('agent.json not found; run init first');
  }
  return migrateConfigV2ToV3(raw);
}

/** 原子写入 V3 配置；首次替换前保留 0600 的 agent.json.v2.bak。 */
export async function writeConfigV3Atomic(
  configDir: string,
  config: AgentConfigV3,
): Promise<void> {
  const validated = parseAgentConfigV3(config);
  const paths = resolveAgentPaths(configDir);
  await backupPreviousConfig(paths.agentFile);
  await writeFileAtomic(paths.agentFile, serialize(validated), CONFIG_FILE_MODE);
}

/** 同步原子写入；供同一调用栈内完成的策略变更使用。 */
export function writeConfigV3AtomicSync(
  configDir: string,
  config: AgentConfigV3,
): void {
  const validated = parseAgentConfigV3(config);
  const paths = resolveAgentPaths(configDir);
  const backup = backupPath(paths.agentFile);
  if (!existsSync(backup) && existsSync(paths.agentFile)) {
    writeFileAtomicSync(
      backup,
      readFileSync(paths.agentFile, 'utf8'),
      CONFIG_FILE_MODE,
    );
  }
  writeFileAtomicSync(paths.agentFile, serialize(validated), CONFIG_FILE_MODE);
}

async function backupPreviousConfig(agentFile: string): Promise<void> {
  const backup = backupPath(agentFile);
  if (existsSync(backup) || !existsSync(agentFile)) return;
  const raw = await readFile(agentFile, 'utf8');
  await writeFileAtomic(backup, raw, CONFIG_FILE_MODE);
}

function backupPath(agentFile: string): string {
  return `${agentFile}${V2_BACKUP_SUFFIX}`;
}

function serialize(config: AgentConfigV3): string {
  return `${JSON.stringify(config, null, 2)}\n`;
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