import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authenticateBearer, AuthError } from '../auth/authenticate.js';
import { sendError } from '../http/send-error.js';
import { DeviceRecord, RelayStore } from '../storage/store.js';

/** 设备路由依赖；onRevoke 由即时断开接线使用。 */
export interface DeviceRoutesDeps {
  store: RelayStore;
  isOnline(deviceId: string): boolean;
  onRevoke?(device: DeviceRecord): void;
}

/** 注册设备列表与吊销路由。 */
export function registerDeviceRoutes(
  app: FastifyInstance,
  deps: DeviceRoutesDeps,
): void {
  const requireDevice = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): DeviceRecord | null => {
    try {
      return authenticateBearer(deps.store, request.headers);
    } catch (error: unknown) {
      if (error instanceof AuthError) {
        sendError(reply, 401, 'UNAUTHENTICATED');
        return null;
      }
      throw error;
    }
  };

  app.get('/v1/desktops', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (device === null) return reply;
    const desktops = deps.store
      .listDevices(device.accountId)
      .filter((entry) => entry.role === 'desktop')
      .map((entry) => ({
        desktopId: entry.deviceId,
        desktopName: entry.deviceName,
        platform: entry.platform,
        appVersion: entry.appVersion,
        online: deps.isOnline(entry.deviceId),
        lastSeenAt: entry.lastSeenAt,
      }));
    return { desktops };
  });

  app.get('/v1/devices', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (device === null) return reply;
    const devices = deps.store.listDevices(device.accountId).map((entry) => ({
      deviceId: entry.deviceId,
      role: entry.role,
      deviceName: entry.deviceName,
      platform: entry.platform,
      appVersion: entry.appVersion,
      revoked: entry.revoked,
      createdAt: entry.createdAt,
      lastSeenAt: entry.lastSeenAt,
      online: deps.isOnline(entry.deviceId),
    }));
    return { devices };
  });

  app.delete('/v1/devices/:deviceId', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (device === null) return reply;
    const { deviceId } = request.params as { deviceId: string };
    if (!deps.store.revokeDevice(device.accountId, deviceId)) {
      return sendError(reply, 404, 'DEVICE_NOT_FOUND');
    }
    const revoked = deps.store.findDevice(deviceId);
    if (revoked !== null) deps.onRevoke?.(revoked);
    return reply.code(204).send();
  });
}