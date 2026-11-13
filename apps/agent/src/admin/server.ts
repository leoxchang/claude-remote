import { stat, unlink } from 'node:fs/promises';

import Fastify, { FastifyInstance } from 'fastify';
import { request } from 'node:http';
import { chmod } from 'node:fs/promises';

import { PairingService } from '../pairing/pairing-service.js';
import { DeviceStorePort } from '../store/device-store.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { registerAdminRoutes } from './routes.js';

/** 管理接口的 socket 权限。 */
const SOCKET_MODE = 0o600;

/** 健康检查超时：超过即视为 stale socket。 */
const HEALTH_TIMEOUT_MS = 500;

/** 本机管理状态。 */
export interface AdminStatus {
  status: 'running';
  desktopId: string;
  listen: { host: string; port: number };
  activeDeviceId: string | null;
}

/** 管理接口依赖；onRevoke 由连接层提供。 */
export interface AdminDependencies {
  socketPath: string;
  pairingService: PairingService;
  deviceStore: DeviceStorePort;
  workspaces?: WorkspaceManager;
  getStatus: () => AdminStatus;
  onRevoke: (deviceId: string) => void;
}

/** 只在 Unix socket 上启动管理接口；拒绝覆盖活跃 socket。 */
export async function createAdminServer(
  deps: AdminDependencies,
): Promise<FastifyInstance> {
  await prepareSocketPath(deps.socketPath);
  const app = Fastify({ logger: false });
  registerAdminRoutes(app, deps);
  await app.listen({ path: deps.socketPath });
  await chmod(deps.socketPath, SOCKET_MODE);
  return app;
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const existing = await stat(socketPath).catch(() => undefined);
  if (existing === undefined) return;
  if (await isSocketServing(socketPath)) {
    throw new Error('admin socket is active; refusing to replace it');
  }
  await unlink(socketPath);
}

function isSocketServing(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request(
      {
        socketPath,
        path: '/admin/v1/status',
        method: 'GET',
        timeout: HEALTH_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    probe.on('error', () => resolve(false));
    probe.on('timeout', () => {
      probe.destroy();
      resolve(false);
    });
    probe.end();
  });
}