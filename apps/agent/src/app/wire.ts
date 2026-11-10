import { FastifyInstance } from 'fastify';

import { AgentDriver } from '../adapter/agent-driver.js';
import { createAdminServer } from '../admin/server.js';
import { CommandRouter } from '../command/router.js';
import { resolveAgentPaths } from '../config/paths.js';
import { AgentConfig } from '../domain/types.js';
import { EventJournal } from '../events/journal.js';
import { EventNormalizer } from '../events/normalizer.js';
import { SnapshotCoordinator } from '../events/snapshot-coordinator.js';
import { PairingService } from '../pairing/pairing-service.js';
import { RunController } from '../run/run-controller.js';
import { SessionController } from '../session/session-controller.js';
import { DeviceStore } from '../store/device-store.js';
import { ConnectionManager } from '../transport/connection-manager.js';
import {
  createPhoneServer,
  PHONE_LISTEN,
} from '../transport/phone-server.js';
import { AgentOperationsImpl } from './agent-operations.js';
import { AgentLogger } from './logger.js';

const AGENT_VERSION = '0.0.0';
const SDK_VERSION = '0.3.319';
const RUNTIME_VERSION = '2.1.319';
const CAPABILITIES = ['text', 'message.delta', 'tool.events', 'session.snapshot'];

/** 组装依赖所需的输入。 */
export interface WireOptions {
  config: AgentConfig;
  driver: AgentDriver;
  configDir: string;
  logger: AgentLogger;
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
  const pairingService = new PairingService({
    deviceStore,
    desktopId: config.desktopId,
    baseUrl: config.tailscale.baseUrl,
  });
  const sessions = new SessionController();
  const journal = new EventJournal();
  const normalizer = new EventNormalizer(journal);
  const runs = new RunController({
    sessions,
    driver,
    journal,
    normalizer,
    cwd: config.workspace.rootPath,
  });

  let connections: ConnectionManager;
  const coordinator = new SnapshotCoordinator({
    journal,
    getSession: (sessionId) => sessions.get(sessionId),
    getActiveRun: (sessionId) => runs.activeRun(sessionId),
    send: (snapshot) => connections.publish(snapshot),
  });
  const operations = new AgentOperationsImpl({
    sessions,
    runs,
    snapshots: coordinator,
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
        getStatus: () => ({
          status: 'running',
          desktopId: config.desktopId,
          listen: { host: config.listen.host, port: config.listen.port },
          activeDeviceId: deviceStore.active()?.deviceId ?? null,
        }),
        onRevoke: (deviceId) => {
          connections.revoke(deviceId);
          logger.info('device.revoked', { deviceId });
        },
      });
      phoneServer = await createPhoneServer({
        pairingService,
        deviceStore,
        workspace: {
          workspaceId: 'default',
          displayName: config.workspace.displayName,
        },
        onConnection: (socket, device) => {
          logger.info('connection.accepted', { deviceId: device.deviceId });
          void connections.accept(socket, device);
        },
      });
      await phoneServer.listen(listen);
      logger.info('agent.started', { desktopId: config.desktopId, listen });
    },
    async close() {
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