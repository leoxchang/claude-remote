import Fastify, { FastifyInstance } from 'fastify';

import { registerLoginRoute } from './auth/login-route.js';
import { registerDeviceRoutes } from './devices/device-routes.js';
import { sendError } from './http/send-error.js';
import { DEFAULT_LIMITS, RelayLimits } from './limits.js';
import { RelayStore } from './storage/store.js';
import { CONTRACT_VERSION, RELAY_VERSION } from './version.js';

export { CONTRACT_VERSION, RELAY_VERSION };

/** 创建应用所需依赖与覆盖项；limits 覆盖仅用于测试。 */
export interface RelayAppOptions {
  store: RelayStore;
  limits?: Partial<RelayLimits>;
  logger?: boolean;
  isOnline?: (deviceId: string) => boolean;
}

/** 组装 Relay Fastify 应用；测试用 inject，运行时由 main.ts listen。 */
export async function createRelayApp(
  options: RelayAppOptions,
): Promise<FastifyInstance> {
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const app = Fastify({
    logger: options.logger === true,
    bodyLimit: limits.httpBodyBytes,
  });

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
    isOnline: options.isOnline ?? (() => false),
  });

  app.setNotFoundHandler(async (_request, reply) =>
    sendError(reply, 404, 'ROUTE_NOT_FOUND'),
  );

  return app;
}