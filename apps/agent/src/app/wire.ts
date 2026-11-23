import { FastifyInstance } from 'fastify';

import { ManagedRunDriver } from '../adapter/managed-run-driver.js';
import { createAdminServer } from '../admin/server.js';
import { ApprovalContentController } from '../approval/approval-content-controller.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { PermissionBroker } from '../approval/permission-broker.js';
import { pendingApprovalSummaries } from '../approval/approval-summary.js';
import { RunApprovalBridge } from '../approval/run-approval-bridge.js';
import { CommandRouter } from '../command/router.js';
import { resolveAgentPaths } from '../config/paths.js';
import { AgentConfigV3 } from '../config/config-v3.js';
import { EventJournal } from '../events/journal.js';
import { EventNormalizer } from '../events/normalizer.js';
import { SnapshotCoordinator } from '../events/snapshot-coordinator.js';
import { PairingService } from '../pairing/pairing-service.js';
import { MAX_ACTIVE_RUNS } from '../run/run-limits.js';
import { ManagedRunController } from '../run/run-controller.js';
import { RunScheduler } from '../run/run-scheduler.js';
import { SessionRegistry } from '../session/session-registry.js';
import { DeviceStore } from '../store/device-store.js';
import { ConnectionManager } from '../transport/connection-manager.js';
import {
  createPhoneServer,
  PHONE_LISTEN,
} from '../transport/phone-server.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { AgentOperationsImpl } from './agent-operations.js';
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
  'session.snapshot',
  'multi.session',
];

/** 组装依赖所需的输入。 */
export interface WireOptions {
  config: AgentConfigV3;
  driver: ManagedRunDriver;
  configDir: string;
  logger: AgentLogger;
  agentInstanceId: string;
}

/** 已组装好的 Agent；start 后才开始监听。 */
export interface AgentWiring {
  operations: AgentOperationsImpl;
  start(listen?: { host: string; port: number }): Promise<void>;
  close(): Promise<void>;
  address(): { host: string; port: number } | null;
}

/** 按唯一路径装配全部组件：命令只走 Router，事件只走 Journal。 */
export async function wireAgent(options: WireOptions): Promise<AgentWiring> {
  const { config, driver, configDir, logger } = options;
  const paths = resolveAgentPaths(configDir);
  const deviceStore = new DeviceStore(configDir);
  let broker: PermissionBroker | null = null;
  let connections: ConnectionManager;
  const pairingService = new PairingService({
    deviceStore,
    desktopId: config.desktopId,
    baseUrl: config.tailscale.baseUrl,
    onDeviceReplaced: (deviceId) => {
      connections.revoke(deviceId);
      broker?.invalidateDevice(deviceId, 'device_revoked');
      logger.info('device.replaced', { deviceId });
    },
  });

  let scheduler: RunScheduler | undefined;
  const workspaces = new WorkspaceManager({
    configDir,
    config,
    usage: {
      hasActiveOrQueued: (workspaceId) =>
        scheduler?.hasActiveOrQueued(workspaceId) ?? false,
    },
    onApprovalModeChanged: (workspaceId, mode) => {
      if (mode !== 'deny') return;
      broker?.invalidateWorkspace(workspaceId, 'policy_disabled');
    },
  });
  const sessions = new SessionRegistry();
  const journal = new EventJournal();
  const normalizer = new EventNormalizer(journal);
  scheduler = new RunScheduler({
    sessions,
    workspaces,
    journal,
    driver,
  });
  const approvalStore = new ApprovalStore();
  const approvalBridge = new RunApprovalBridge({
    scheduler,
    workspaces,
    devices: deviceStore,
    journal,
    normalizer,
    logger,
  });
  const permissionBroker = new PermissionBroker({
    store: approvalStore,
    ports: approvalBridge,
    events: approvalBridge,
  });
  broker = permissionBroker;
  scheduler.setPermissionBroker(permissionBroker);
  const approvalContent = new ApprovalContentController({
    store: approvalStore,
    settleExpired: (approvalId) => {
      permissionBroker.settleIfExpired(approvalId);
    },
  });
  const runs = new ManagedRunController({
    scheduler,
    sessions,
    normalizer,
    permissionBroker,
  });

  const coordinator = new SnapshotCoordinator({
    journal,
    getSession: (sessionId) => sessions.get(sessionId),
    getActiveRun: (sessionId) => sessions.get(sessionId).activeRun,
    getQueuedRuns: (sessionId) => scheduler.queuedRuns(sessionId),
    getPendingApprovals: (sessionId) =>
      pendingApprovalSummaries(approvalStore, sessionId),
    getGlobalCapacity: () => ({
      activeRunCount: scheduler.activeCount(),
      maxActiveRuns: MAX_ACTIVE_RUNS,
    }),
    send: (snapshot) => connections.publish(snapshot),
  });
  const operations = new AgentOperationsImpl({
    workspaces,
    sessions,
    scheduler,
    runs,
    snapshots: coordinator,
    approvalBroker: permissionBroker,
    approvalStore,
    currentEpoch: () => {
      const active = deviceStore.active();
      return active === null ? 0 : connections.currentEpoch(active.deviceId);
    },
  });
  const router = new CommandRouter({ operations });

  const handleCommand = async (
    deviceId: string,
    raw: string,
  ): Promise<void> => {
    const device = deviceStore
      .list()
      .find((entry) => entry.deviceId === deviceId);
    if (device === undefined) return;
    const parsed = parseCommand(raw);
    const result = await router.route(parsed, device);
    connections.publish(result);
    logger.info('command.processed', {
      deviceId,
      commandId: result.commandId,
      status: result.payload.status,
      duplicate: result.payload.duplicate,
    });
  };

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

  let phoneServer: FastifyInstance | null = null;
  let adminServer: FastifyInstance | null = null;

  return {
    operations,
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
          connections.revoke(deviceId);
          permissionBroker.invalidateDevice(deviceId, 'device_revoked');
          logger.info('device.revoked', { deviceId });
        },
      });
      phoneServer = await createPhoneServer({
        pairingService,
        deviceStore,
        workspace:
          config.workspaces[0] === undefined
            ? { workspaceId: 'default', displayName: 'default' }
            : {
                workspaceId: config.workspaces[0].workspaceId,
                displayName: config.workspaces[0].displayName,
              },
        logger,
        onConnection: (socket, device) => {
          logger.info('connection.accepted', { deviceId: device.deviceId });
          void connections.accept(socket, device);
        },
        approvalContent,
      });
      await phoneServer.listen(listen);
      logger.info('agent.started', { desktopId: config.desktopId, listen });
    },
    async close() {
      permissionBroker.invalidateAll('agent_shutdown');
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