import { FastifyInstance } from 'fastify';

import { ManagedRunDriver } from '../adapter/managed-run-driver.js';
import { createAdminServer } from '../admin/server.js';
import { ApprovalContentController } from '../approval/approval-content-controller.js';
import { DurableApprovalStore } from '../approval/durable-approval-store.js';
import { DurablePermissionBroker } from '../approval/durable-permission-broker.js';
import { CommandRouter } from '../command/router.js';
import { AgentConfigV4 } from '../config/config-v4.js';
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
import {
  createPhoneServer,
  PHONE_LISTEN,
} from '../transport/phone-server.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { DurableAgentOperations } from './durable-agent-operations.js';
import { AgentLogger } from './logger.js';

const AGENT_VERSION = '0.0.0';
const SDK_VERSION = '0.3.319';
const RUNTIME_VERSION = '2.1.319';
const CAPABILITIES = [
  'text',
  'message.delta',
  'tool.events',
  'multi.session',
  'durable.state',
];

export interface DurableWireOptions {
  config: AgentConfigV4;
  database: AgentDatabase;
  driver: ManagedRunDriver;
  configDir: string;
  logger: AgentLogger;
  agentInstanceId: string;
}

export interface DurableWiring {
  operations: DurableAgentOperations;
  recovery: RecoveryService;
  retention: RetentionService;
  health: StorageHealth;
  start(listen?: { host: string; port: number }): Promise<void>;
  close(): Promise<void>;
  address(): { host: string; port: number } | null;
}

/** S04 唯一装配路径：SQLite 投影为权威，Journal 只发布已提交事件。 */
export function wireDurableAgent(options: DurableWireOptions): DurableWiring {
  const { config, database, driver, configDir, logger } = options;
  const paths = resolveAgentPaths(configDir);
  const uow = database.uow;
  const deviceStore = new SqliteDeviceStore(uow);
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
      deviceActive: (deviceId) =>
        deviceStore
          .list()
          .some(
            (device) =>
              device.deviceId === deviceId && device.revokedAt === null,
          ),
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
  const runPrompt = new RunPromptController({ runs, devices: deviceStore });
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
  });

  const pairingService = new PairingService({
    deviceStore,
    desktopId: config.desktopId,
    baseUrl: config.tailscale.baseUrl,
    onDeviceReplaced: (deviceId) => {
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
    const result = await router.route(parseCommand(raw), device);
    connections.publish(result);
    logger.info('command.processed', {
      deviceId,
      commandId: result.commandId,
      status: result.payload.status,
      duplicate: result.payload.duplicate,
    });
  };

  let phoneServer: FastifyInstance | null = null;
  let adminServer: FastifyInstance | null = null;

  return {
    operations,
    recovery,
    retention,
    health,
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
        }),
        onRevoke: (deviceId) => {
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
        onConnection: (socket, device) => {
          logger.info('connection.accepted', { deviceId: device.deviceId });
          void connections.accept(socket, device);
        },
        approvalContent,
        runPrompt,
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