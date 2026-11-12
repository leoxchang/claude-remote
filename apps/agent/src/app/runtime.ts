import { ManagedRunDriver } from '../adapter/managed-run-driver.js';
import { readJsonFileIfExists } from '../config/atomic-file.js';
import {
  migrateConfigV1ToV2,
  writeConfigV2Atomic,
} from '../config/config-v2.js';
import { DEFAULT_CONFIG_DIR, resolveAgentPaths } from '../config/paths.js';
import { AgentConfig, AgentConfigV2 } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';
import { PHONE_LISTEN } from '../transport/phone-server.js';
import { AgentOperations } from './agent-operations.js';
import { AgentLogger, createFileLogger } from './logger.js';
import { wireAgent } from './wire.js';

/** agentInstanceId 的随机字节数；每次启动重新生成。 */
const AGENT_INSTANCE_BYTES = 9;

/** 运行中的 Agent；start 之后才开始监听。 */
export interface AgentRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
  operations: AgentOperations;
  /** 每次进程启动生成的实例标识；desktopId 保持不变。 */
  agentInstanceId: string;
  address(): { host: string; port: number } | null;
}

/** 可选的运行时配置；生产默认值来自固定路径。 */
export interface AgentRuntimeOptions {
  configDir?: string;
  phoneListen?: { host: string; port: number };
  logger?: AgentLogger;
  agentInstanceId?: string;
}

/** 组装一个 Agent 运行时；命令层与测试共用同一装配路径。 */
export async function createAgentRuntime(
  config: AgentConfig | AgentConfigV2,
  driver: ManagedRunDriver,
  options: AgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
  const logger =
    options.logger ?? createFileLogger(resolveAgentPaths(configDir).logFile);
  const configV2 = await resolveStartupConfig(configDir, config);
  const agentInstanceId =
    options.agentInstanceId ?? `agent_${randomBase64Url(AGENT_INSTANCE_BYTES)}`;
  const wiring = await wireAgent({
    config: configV2,
    driver,
    configDir,
    logger,
    agentInstanceId,
  });
  let started = false;

  return {
    operations: wiring.operations,
    agentInstanceId,
    async start() {
      if (started) return;
      await wiring.start(
        options.phoneListen ?? {
          host: PHONE_LISTEN.host,
          port: PHONE_LISTEN.port,
        },
      );
      started = true;
    },
    async close() {
      await wiring.close();
      started = false;
    },
    address() {
      return started ? wiring.address() : null;
    },
  };
}

/**
 * 启动时读取并迁移配置。
 *
 * V1 配置迁移为 V2 并原子写回，原文件保留为 agent.json.v1.bak；
 * 配置缺失或非法时直接失败，不创建空配置。
 */
async function resolveStartupConfig(
  configDir: string,
  fallback: AgentConfig | AgentConfigV2,
): Promise<AgentConfigV2> {
  const paths = resolveAgentPaths(configDir);
  const raw = await readJsonFileIfExists(paths.agentFile);
  if (raw === undefined) {
    const migrated = migrateConfigV1ToV2(fallback);
    await writeConfigV2Atomic(configDir, migrated);
    return migrated;
  }
  const migrated = migrateConfigV1ToV2(raw);
  if (isVersion(1, raw)) await writeConfigV2Atomic(configDir, migrated);
  return migrated;
}

function isVersion(version: number, raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { version?: unknown }).version === version
  );
}