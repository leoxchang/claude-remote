import { ManagedRunDriver } from '../adapter/managed-run-driver.js';
import { DEFAULT_CONFIG_DIR, resolveAgentPaths } from '../config/paths.js';
import { AgentConfig } from '../domain/types.js';
import { AgentOperations } from '../session/session-controller.js';
import { PHONE_LISTEN } from '../transport/phone-server.js';
import { AgentLogger, createFileLogger } from './logger.js';
import { wireAgent } from './wire.js';

/** 运行中的 Agent；start 之后才开始监听。 */
export interface AgentRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
  operations: AgentOperations;
  address(): { host: string; port: number } | null;
}

/** 可选的运行时配置；生产默认值来自固定路径。 */
export interface AgentRuntimeOptions {
  configDir?: string;
  phoneListen?: { host: string; port: number };
  logger?: AgentLogger;
}

/** 组装一个 Agent 运行时；命令层与测试共用同一装配路径。 */
export async function createAgentRuntime(
  config: AgentConfig,
  driver: ManagedRunDriver,
  options: AgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
  const logger =
    options.logger ?? createFileLogger(resolveAgentPaths(configDir).logFile);
  const wiring = await wireAgent({ config, driver, configDir, logger });
  let started = false;

  return {
    operations: wiring.operations,
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