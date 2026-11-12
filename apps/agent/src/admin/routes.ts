import { FastifyInstance, FastifyReply } from 'fastify';

import { PairingError } from '../pairing/pairing-service.js';
import { registerWorkspaceRoutes } from '../workspace/workspace-admin.js';
import { AdminDependencies } from './server.js';

/** 注册只在本机 Unix socket 上可用的管理路由。 */
export function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminDependencies,
): void {
  app.get('/admin/v1/status', async () => deps.getStatus());

  if (deps.workspaces !== undefined) {
    registerWorkspaceRoutes(app, { workspaces: deps.workspaces });
  }

  app.get('/admin/v1/devices', async () => deps.deviceStore.list());

  app.post('/admin/v1/pair', async (request, reply) => {
    const body = (request.body ?? {}) as { replace?: unknown };
    try {
      return deps.pairingService.begin(body.replace === true);
    } catch (error: unknown) {
      if (error instanceof PairingError) {
        return sendError(reply, 409, error.code);
      }
      throw error;
    }
  });

  app.post('/admin/v1/revoke', async (request, reply) => {
    const body = (request.body ?? {}) as { deviceId?: unknown };
    if (typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
      return sendError(reply, 400, 'INVALID_MESSAGE');
    }
    if (!deps.deviceStore.list().some((entry) => entry.deviceId === body.deviceId)) {
      return sendError(reply, 404, 'DEVICE_NOT_FOUND');
    }
    const record = await deps.deviceStore.revoke(body.deviceId);
    deps.onRevoke(record.deviceId);
    return record;
  });
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
): FastifyReply {
  return reply.code(statusCode).send({ error: { code, message: code } });
}