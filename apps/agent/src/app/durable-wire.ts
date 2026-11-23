import { FastifyInstance } from 'fastify';

import { ManagedRunDriver } from '../adapter/managed-run-driver.js';
import { createAdminServer } from '../admin/server.js';
import { ApprovalContentController } from '../approval/approval-content-controller.js';
import { AsrRuntime, createAsrRuntime } from '../asr/asr-runtime.js';
import { AttachmentStore } from '../attachment/attachment-store.js';
import { DurableApprovalStore } from '../approval/durable-approval-store.js';
import { DurablePermissionBroker } from '../approval/durable-permission-broker.js';
import { CommandRouter } from '../command/router.js';
import { AgentConfigV5 } from '../config/config-v5.js';
import { resolveAgentPaths } from '../config/paths.js';
import { DurableEventJournal } from '../events/durable-event-journal.js';
import { DurableJournalAdapter } from '../events/durable-journal-adapter.js';
import { EventNormalizer } from '../events/normalizer.js';
import { PairingService } from '../pairing/pairing-service.js';
import { MAX_ACTIVE_RUNS } from '../run/run-limits.js';
import { DurableRunController } from '../run/durable-run-controller.js';
import { DurableRunScheduler } from '../run/durable-run-scheduler.js';
import { PromptAdmission } from '../run/prompt-admission.js';
import { RecoveryService } from '../run/recovery-service.js';
import { RunPromptController } from '../run/run-prompt-controller.js';
import { createTrustedDevices, TrustedDevices } from '../relay/trusted-devices.js';
import { SessionSyncService } from '../sync/session-sync-service.js';
import { SnapshotService } from '../sync/snapshot-service.js';
import { AgentDatabase } from '../storage/database.js';
import { PersistentCommandExecutor } from '../storage/persistent-command-executor.js';
import { SqliteDeviceStore } from '../storage/repositories/device-repository.js';
import { RunRepository } from '../storage/repositories/run-repository.js';
import { SessionRepository } from '../storage/repositories/session-repository.js';
import { SqliteWorkspaceRepository } from '../storage/repositories/workspace-repository.js';
import { StorageHealth } from '../storage/storage-health.js';
import { RetentionService } from '../storage/retention-service.js';
import { CommandRepository } from '../storage/repositories/command-repository.js';
import { ConnectionManager } from '../transport/connection-manager.js';
import { authenticateRequest } from '../transport/authenticate.js';
import {
  createPhoneServer,
  PHONE_LISTEN,
} from '../transport/phone-server.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { DurableAgentOperations } from './durable-agent-operations.js';
import { AgentLogger } from './logger.js';
import {
  AGENT_VERSION,
  RUNTIME_VERSION,
  SDK_VERSION,
  agentVersions,
} from './versions.js';

const CAPABILITIES = [
  'text',
  'message.delta',
  'tool.events',
  'multi.session',
  'durable.state',
];

export interface DurableWireOptions {
  config: AgentConfigV5;
  database: AgentDatabase;
  driver: ManagedRunDriver;
  configDir: string;
  logger: AgentLogger;
  agentInstanceId: string;
  /** 图片附件存储；必须与 driver 读取的是同一实例/同一目录。 */
  attachments: AttachmentStore;
  /** 进程环境；ASR Key 只在启动时读取。 */
  env?: NodeJS.ProcessEnv;
}

export interface DurableWiring {
  operations: DurableAgentOperations;
  recovery: RecoveryService;
  retention: RetentionService;
  health: StorageHealth;
  /** 信任设备叠加；云端手机经此放行审批与 prompt 读取。 */
  relayDevices: TrustedDevices;
  start(listen?: { host: string; port: number }): Promise<void>;
  close(): Promise<void>;
  address(): { host: string; port: number } | null;
}

/** S04 唯一装配路径：SQLite 投影为权威，Journal 只发布已提交事件。 */
export function wireDurableAgent(options: DurableWireOptions): DurableWiring {
  const { config, database, driver, configDir, logger, attachments } = options;
  const paths = resolveAgentPaths(configDir);
  const uow = database.uow;
  const deviceStore = new SqliteDeviceStore(uow);
  const relayDevices = createTrustedDevices(
    (deviceId) =>
      deviceStore
        .list()
        .some(
          (device) =>
            device.deviceId === deviceId && device.revokedAt === null,
        ),
  );
  const sessions = new SessionRepository(uow);
  const runs = new RunRepository(uow);
  const workspacesRepository = new SqliteWorkspaceRepository(uow);
  const journal = new DurableEventJournal(uow);
  const journalAdapter = new DurableJournalAdapter(journal);
  const normalizer = new EventNormalizer(journalAdapter);
  const health = new StorageHealth();

  let connections: ConnectionManager;
  let scheduler: DurableRunScheduler;
  let broker: DurablePermissionBroker;
  const workspaces = new WorkspaceManager({
    repository: workspacesRepository,
    usage: {
      hasActiveOrQueued: (workspaceId) =>
        runs
          .listByStatus('queued')
          .concat(runs.listByStatus('recovery_required'))
          .some((run) => run.workspaceId === workspaceId) ||
        scheduler.activeCount() > 0,
    },
    onApprovalModeChanged: (workspaceId, mode) => {
      if (mode !== 'deny') return;
      broker.invalidateWorkspace(workspaceId, 'policy_disabled');
    },
  });

  scheduler = new DurableRunScheduler({
    uow,
    sessions,
    runs,
    workspaces: workspacesRepository,
    journal,
    driver,
  });
  const approvalStore = new DurableApprovalStore(uow, journal);
  broker = new DurablePermissionBroker({
    store: approvalStore,
    health,
    ports: {
      runContext: (runId) => scheduler.approvalContext(runId),
      workspaceMode: (workspaceId) => workspaces.approvalMode(workspaceId),
      deviceActive: (deviceId) => relayDevices.isActive(deviceId),
      setPendingApprovalCount: (runId, count) =>
        scheduler.setPendingApprovalCount(runId, count),
    },
    events: {
      reportError: (error) =>
        logger.warn('approval.rejected', {
          code: error.code,
          runId: error.runId,
        }),
      toolDenied: (notice) =>
        normalizer.consume({
          kind: 'permissionDenied',
          sessionId: notice.sessionId,
          runId: notice.runId,
          ...(notice.toolUseID === undefined
            ? {}
            : { toolUseId: notice.toolUseID }),
          toolName: notice.toolName,
          outcome: notice.outcome,
        }),
    },
  });
  const runController = new DurableRunController({
    scheduler,
    sessions,
    normalizer,
    permissionBroker: broker,
  });

  const executor = new PersistentCommandExecutor({ uow, appender: journal });
  const admission = new PromptAdmission({
    executor,
    sessions,
    runs,
    workspaces: workspacesRepository,
    onAccepted: () => scheduler.drain(),
    health,
  });
  const recovery = new RecoveryService({
    executor,
    runs,
    sessions,
    workspaces: workspacesRepository,
    onAccepted: () => scheduler.drain(),
    health,
  });
  const runPrompt = new RunPromptController({
    runs,
    devices: deviceStore,
    isActiveDevice: (deviceId) => relayDevices.isActive(deviceId),
  });
  const snapshots = new SnapshotService({
    executor,
    journal,
    sessions,
    runs,
    approvals: approvalStore,
    uow,
  });
  const retention = new RetentionService({
    uow,
    journal,
    runs,
    sessions,
    commands: new CommandRepository(uow),
    snapshots,
    health,
  });
  const syncService = new SessionSyncService({
    executor,
    journal,
    snapshots,
    sessions,
    runs,
  });
  const approvalContent = new ApprovalContentController({
    store: approvalStore,
    settleExpired: (approvalId) => {
      broker.settleIfExpired(approvalId);
    },
  });

  const operations = new DurableAgentOperations({
    workspaces,
    sessions,
    runs,
    scheduler,
    controller: runController,
    admission,
    broker,
    approvals: approvalStore,
    journal,
  });
  const router = new CommandRouter({
    operations,
    sync: syncService,
    snapshots,
    recovery,
    attachments,
  });

  const pairingService = new PairingService({
    deviceStore,
    desktopId: config.desktopId,
    baseUrl: config.tailscale.baseUrl,
    onDeviceReplaced: (deviceId) => {
      asrRuntime?.close('device_revoked');
      connections.revoke(deviceId);
      broker.invalidateDevice(deviceId, 'device_revoked');
      logger.info('device.replaced', { deviceId });
    },
  });

  connections = new ConnectionManager({
    desktopId: config.desktopId,
    agentInstanceId: options.agentInstanceId,
    versions: {
      agent: AGENT_VERSION,
      sdk: SDK_VERSION,
      runtime: RUNTIME_VERSION,
    },
    capabilities: CAPABILITIES,
    onCommand: (deviceId, raw) => {
      void handleCommand(deviceId, raw);
    },
  });
  journal.subscribe((event) => {
    if (event.type === 'run.started' || event.type === 'run.completed') {
      logger.info(event.type, {
        eventId: event.eventId,
        sessionId: event.sessionId,
        runId: event.runId,
        seq: event.seq,
      });
    }
    connections.publish(event);
  });

  const handleCommand = async (
    deviceId: string,
    raw: string,
  ): Promise<void> => {
    const device = deviceStore
      .list()
      .find((entry) => entry.deviceId === deviceId);
    if (device === undefined) return;
    const command = parseCommand(raw);
    const result = await router.route(command, device);
    connections.publish(result);
    logger.info('command.processed', {
      deviceId,
      commandId: result.commandId,
      traceId: result.traceId,
      ...commandLogIds(command),
      status: result.payload.status,
      duplicate: result.payload.duplicate,
    });
  };

  let phoneServer: FastifyInstance | null = null;
  let adminServer: FastifyInstance | null = null;
  let asrRuntime: AsrRuntime | null = null;

  return {
    operations,
    recovery,
    retention,
    health,
    relayDevices,
    async start(listen = { host: PHONE_LISTEN.host, port: PHONE_LISTEN.port }) {
      adminServer = await createAdminServer({
        socketPath: paths.socketPath,
        pairingService,
        deviceStore,
        workspaces,
        getStatus: () => ({
          status: 'running',
          desktopId: config.desktopId,
          listen: { host: config.listen.host, port: config.listen.port },
          activeDeviceId: deviceStore.active()?.deviceId ?? null,
          versions: agentVersions(),
        }),
        onRevoke: (deviceId) => {
          asrRuntime?.close('device_revoked');
          connections.revoke(deviceId);
          broker.invalidateDevice(deviceId, 'device_revoked');
          logger.info('device.revoked', { deviceId });
        },
      });
      const first = workspaces.list()[0];
      phoneServer = await createPhoneServer({
        pairingService,
        deviceStore,
        workspace:
          first === undefined
            ? { workspaceId: 'default', displayName: 'default' }
            : {
                workspaceId: first.workspaceId,
                displayName: first.displayName,
              },
        logger,
        onConnection: (socket, device) => {
          logger.info('connection.accepted', { deviceId: device.deviceId });
          void connections.accept(socket, device);
        },
        approvalContent,
        runPrompt,
        attachments,
      });
      asrRuntime = createAsrRuntime({
        app: phoneServer,
        env: options.env ?? process.env,
        authenticate: async (request) => {
          const device = await authenticateRequest(
            request.headers as Record<string, unknown>,
            deviceStore,
          ).catch(() => null);
          return device === null ? null : { deviceId: device.deviceId };
        },
      });
      await phoneServer.listen(listen);
      logger.info('agent.started', {
        desktopId: config.desktopId,
        listen,
        maxActiveRuns: MAX_ACTIVE_RUNS,
      });
    },
    async close() {
      broker.invalidateAll('agent_shutdown');
      asrRuntime?.close('agent_shutdown');
      asrRuntime = null;
      if (phoneServer !== null) {
        await phoneServer.close();
        phoneServer = null;
      }
      if (adminServer !== null) {
        await adminServer.close();
        adminServer = null;
      }
    },
    address() {
      const address = phoneServer?.server.address();
      if (address === null || address === undefined || typeof address === 'string') {
        return null;
      }
      return { host: address.address, port: address.port };
    },
  };
}

function parseCommand(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/** 从命令信封提取可安全写日志的会话/run 标识；缺失时不写该字段。 */
function commandLogIds(command: unknown): {
  sessionId?: string;
  runId?: string;
} {
  if (typeof command !== 'object' || command === null) return {};
  const record = command as Record<string, unknown>;
  const sessionId = record['sessionId'];
  const runId = record['runId'];
  return {
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof runId === 'string' ? { runId } : {}),
  };
}