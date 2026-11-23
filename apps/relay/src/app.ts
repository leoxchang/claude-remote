import { IncomingMessage } from 'node:http';

import websocket from '@fastify/websocket';
import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { authenticateBearer, AuthError } from './auth/authenticate.js';
import { registerLoginRoute } from './auth/login-route.js';
import { registerDeviceRoutes } from './devices/device-routes.js';
import { sendError } from './http/send-error.js';
import { DEFAULT_LIMITS, RelayLimits } from './limits.js';
import { acceptDesktopConnection } from './routing/desktop-link.js';
import { ConnectionRegistry } from './routing/registry.js';
import { DeviceRecord, RelayStore } from './storage/store.js';
import { CONTRACT_VERSION, RELAY_VERSION } from './version.js';

export { CONTRACT_VERSION, RELAY_VERSION };

/** 创建应用所需依赖与覆盖项；limits 覆盖仅用于测试。 */
export interface RelayAppOptions {
  store: RelayStore;
  limits?: Partial<RelayLimits>;
  logger?: boolean;
  isOnline?: (deviceId: string) => boolean;
  registry?: ConnectionRegistry;
}

/** 组装 Relay Fastify 应用；测试用 inject，运行时由 cli.ts listen。 */
export async function createRelayApp(
  options: RelayAppOptions,
): Promise<FastifyInstance> {
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const registry = options.registry ?? new ConnectionRegistry();
  const app = Fastify({
    logger: options.logger === true,
    bodyLimit: limits.httpBodyBytes,
  });
  await app.register(websocket);

  app.get('/v1/version', async () => ({
    contractVersion: CONTRACT_VERSION,
    relayVersion: RELAY_VERSION,
  }));

  registerLoginRoute(app, {
    store: options.store,
    loginPerMinute: limits.loginPerMinute,
  });

  registerDeviceRoutes(app, {
    store: options.store,
    isOnline: options.isOnline ?? ((deviceId) => registry.isOnline(deviceId)),
  });

  const authenticated = new WeakMap<IncomingMessage, DeviceRecord>();
  const desktopAuth = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    try {
      const device = authenticateBearer(options.store, request.headers);
      if (device.role !== 'desktop') {
        sendError(reply, 403, 'FORBIDDEN');
        return;
      }
      authenticated.set(request.raw, device);
    } catch (error: unknown) {
      if (error instanceof AuthError) {
        sendError(reply, 401, 'UNAUTHENTICATED');
        return;
      }
      throw error;
    }
  };

  app.get(
    '/v1/desktop/ws',
    { websocket: true, preValidation: desktopAuth },
    (socket, request) => {
      const device = authenticated.get(request.raw);
      if (device === undefined) {
        socket.close();
        return;
      }
      acceptDesktopConnection({
        socket,
        device,
        store: options.store,
        registry,
        limits,
      });
    },
  );

  app.setNotFoundHandler(async (_request, reply) =>
    sendError(reply, 404, 'ROUTE_NOT_FOUND'),
  );

  return app;
}