import { ManagedRunDriver } from '../adapter/managed-run-driver.js';
import { readJsonFileIfExists } from '../config/atomic-file.js';
import {
  AgentConfigV3,
  migrateConfigV2ToV3,
  writeConfigV3Atomic,
} from '../config/config-v3.js';
import {
  AgentConfigV4,
  readConfigV4IfExists,
  resolveDatabasePath,
} from '../config/config-v4.js';
import {
  AgentConfigV5,
  migrateV4ToV5,
  readConfigV5IfExists,
  writeConfigV5AtomicSync,
} from '../config/config-v5.js';
import {
  migrateConfigV1ToV2,
  writeConfigV2Atomic,
} from '../config/config-v2.js';
import { DEFAULT_CONFIG_DIR, resolveAgentPaths } from '../config/paths.js';
import { AgentConfig, AgentConfigV2 } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';
import { AgentDatabase } from '../storage/database.js';
import { RetentionService } from '../storage/retention-service.js';
import { StorageHealth } from '../storage/storage-health.js';
import { InstanceLock, InstanceLockHandle } from '../storage/instance-lock.js';
import {
  migrateV3Sources,
  sha256Text,
  SourceHashes,
} from '../storage/config-v4-migration.js';
import { ApprovalRepository } from '../storage/repositories/approval-repository.js';
import { RunRepository } from '../storage/repositories/run-repository.js';
import { SessionRepository } from '../storage/repositories/session-repository.js';
import { RecoveryReport, StartupRecovery } from '../storage/startup-recovery.js';
import { DurableEventJournal } from '../events/durable-event-journal.js';
import { RecoveryService } from '../run/recovery-service.js';
import { AgentOperations } from './agent-operations.js';
import { wireDurableAgent } from './durable-wire.js';
import { AttachmentStore } from '../attachment/attachment-store.js';
import { AgentLogger, createFileLogger } from './logger.js';
import { wireAgent } from './wire.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  /** 图片附件存储；未提供时使用配置目录下的默认位置。 */
  attachments?: AttachmentStore;
  /** 进程环境；ASR 配置只在启动时读取一次。 */
  env?: NodeJS.ProcessEnv;
}

/** 组装一个 Agent 运行时；命令层与测试共用同一装配路径。 */
export async function createAgentRuntime(
  config: AgentConfig | AgentConfigV2 | AgentConfigV3,
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
          host: configV2.listen.host,
          port: configV2.listen.port,
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
 * S04 运行时：加锁 → 打开/迁移/integrity → 启动修复 → 装配 → 监听。
 *
 * 迁移、修复或 integrity 任一步失败时不开放端口、不创建 Scheduler。
 */
export async function createDurableAgentRuntime(
  driver: ManagedRunDriver,
  options: AgentRuntimeOptions = {},
): Promise<
    AgentRuntime & {
      recovery: RecoveryReport;
      recoveryService: RecoveryService;
      retention: RetentionService;
      health: StorageHealth;
    }
  > {
  const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
  const paths = resolveAgentPaths(configDir);
  const logger =
    options.logger ?? createFileLogger(resolveAgentPaths(configDir).logFile);
  const agentInstanceId =
    options.agentInstanceId ?? `agent_${randomBase64Url(AGENT_INSTANCE_BYTES)}`;
  const raw = await readJsonFileIfExists(paths.agentFile);
  if (raw === undefined) {
    throw new Error('agent.json not found; run init first');
  }
  const existingV4 = readConfigV4IfExists(configDir);
  const existingV5 = readConfigV5IfExists(configDir);
  const desktopId =
    existingV4?.desktopId ??
    existingV5?.desktopId ??
    migrateConfigV2ToV3(raw).desktopId;
  const databasePath =
    existingV4 !== null
      ? resolveDatabasePath(configDir, existingV4)
      : existingV5 !== null
        ? join(configDir, existingV5.database.file)
        : join(configDir, 'agent.sqlite3');
  let lock: InstanceLockHandle | null = null;
  let database: AgentDatabase | null = null;
  try {
    lock = InstanceLock.acquire({
      lockPath: join(configDir, 'agent.lock'),
      desktopId,
      databasePath,
    });
    database = AgentDatabase.open(databasePath);
    const config = ensureV5Config(configDir, existingV4, database);
    const journal = new DurableEventJournal(database.uow);
    const recovery = new StartupRecovery({
      uow: database.uow,
      journal,
      runs: new RunRepository(database.uow),
      sessions: new SessionRepository(database.uow),
      approvals: new ApprovalRepository(database.uow),
    });
    const report = recovery.repair({ agentInstanceId });
    const wiring = wireDurableAgent({
      config,
      database,
      driver,
      configDir,
      logger,
      agentInstanceId,
      attachments:
        options.attachments ??
        new AttachmentStore(join(configDir, 'attachments')),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    wiring.retention.runOnce(Date.now());
    wiring.retention.evaluateCapacity(runtimeLiveBytes(database));
    const runtimeDatabase = database;
    const runtimeLock = lock;
    let started = false;
    let retentionTimer: ReturnType<typeof setInterval> | null = null;
    return {
      operations: wiring.operations,
      agentInstanceId,
      recovery: report,
      recoveryService: wiring.recovery,
      retention: wiring.retention,
      health: wiring.health,
      async start() {
        if (started) return;
        await wiring.start(
          options.phoneListen ?? {
            host: config.listen.host,
            port: config.listen.port,
          },
        );
        started = true;
        retentionTimer = setInterval(() => {
          try {
            wiring.retention.runOnce(Date.now());
            wiring.retention.evaluateCapacity(runtimeLiveBytes(runtimeDatabase));
          } catch {
            // 定期清理失败不杀死进程；存储健康由下一次写入/启动修复兜底。
            wiring.health.degraded('unavailable');
          }
        }, 15 * 60 * 1000);
      },
      async close() {
        if (retentionTimer !== null) {
          clearInterval(retentionTimer);
          retentionTimer = null;
        }
        await wiring.close();
        runtimeDatabase.close();
        runtimeLock.release();
        started = false;
      },
      address() {
        return started ? wiring.address() : null;
      },
    };
  } catch (error: unknown) {
    database?.close();
    lock?.release();
    throw error;
  }
}

function runtimeLiveBytes(database: AgentDatabase): number {
  return database.liveBytes();
}

/** V5 优先：已有 v5 直接用；否则完成既有 v4 迁移链并把结果升级为 v5 落盘。 */
function ensureV5Config(
  configDir: string,
  existingV4: AgentConfigV4 | null,
  database: AgentDatabase,
): AgentConfigV5 {
  const state = database.connection
    .prepare('SELECT migrationState FROM schema_meta WHERE id = 1')
    .get() as { migrationState?: string } | undefined;
  const existingV5 = readConfigV5IfExists(configDir);
  if (existingV5 !== null) {
    if (state?.migrationState !== 'completed') {
      throw new Error('STORAGE_MIGRATION_CONFLICT');
    }
    return existingV5;
  }
  const v4 = ensureV4ConfigState(configDir, existingV4, database, state);
  const migrated = migrateV4ToV5(v4);
  writeConfigV5AtomicSync(configDir, migrated);
  return migrated;
}

function ensureV4ConfigState(
  configDir: string,
  existingV4: AgentConfigV4 | null,
  database: AgentDatabase,
  state: { migrationState?: string } | undefined,
): AgentConfigV4 {
  if (existingV4 !== null) {
    if (state?.migrationState !== 'completed') {
      throw new Error('STORAGE_MIGRATION_CONFLICT');
    }
    return existingV4;
  }
  const paths = resolveAgentPaths(configDir);
  const hashes: SourceHashes = {
    config: sha256Text(readFileSync(paths.agentFile, 'utf8')),
    devices: existsSync(paths.devicesFile)
      ? sha256Text(readFileSync(paths.devicesFile, 'utf8'))
      : null,
  };
  migrateV3Sources({
    configDir,
    uow: database.uow,
    sourceHashes: hashes,
    now: Date.now(),
  });
  const migrated = readConfigV4IfExists(configDir);
  if (migrated === null) {
    throw new Error('STORAGE_MIGRATION_CONFLICT');
  }
  return migrated;
}

/**
 * 启动时读取并迁移配置。
 *
 * V1 先迁移并写回 V2（保留 agent.json.v1.bak），再迁移到 V3
 * （保留 agent.json.v2.bak，全部项目默认 deny）；配置缺失或非法时直接失败。
 */
async function resolveStartupConfig(
  configDir: string,
  fallback: AgentConfig | AgentConfigV2 | AgentConfigV3,
): Promise<AgentConfigV3> {
  const paths = resolveAgentPaths(configDir);
  const raw = await readJsonFileIfExists(paths.agentFile);
  if (raw === undefined) {
    const migrated = migrateConfigV2ToV3(fallback);
    await writeConfigV3Atomic(configDir, migrated);
    return migrated;
  }
  const version = configVersion(raw);
  if (version === 1) {
    await writeConfigV2Atomic(configDir, migrateConfigV1ToV2(raw));
  }
  const migrated = migrateConfigV2ToV3(raw);
  if (version !== 3) await writeConfigV3Atomic(configDir, migrated);
  return migrated;
}

function configVersion(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const version = (raw as { version?: unknown }).version;
  return typeof version === 'number' ? version : null;
}