import { IncomingMessage } from 'node:http';

import websocket from '@fastify/websocket';
import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { WebSocket } from 'ws';

import { authenticateBearer, AuthError } from './auth/authenticate.js';
import { registerLoginRoute } from './auth/login-route.js';
import { registerDeviceRoutes } from './devices/device-routes.js';
import { sendError } from './http/send-error.js';
import { DEFAULT_LIMITS, RelayLimits } from './limits.js';
import { acceptDesktopConnection } from './routing/desktop-link.js';
import {
  acceptPhoneChannel,
  closeDesktopChannels,
  handleDesktopMessage,
} from './routing/splice.js';
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
  // maxPayload 只能全局设置：取 16MiB 桌面消息上限的两倍，
  // 具体限制由拼接层按契约判定（超限关闭 4003），而不是底层 1009。
  await app.register(websocket, {
    options: { maxPayload: limits.desktopMessageBytes * 2 },
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
    isOnline: options.isOnline ?? ((deviceId) => registry.isOnline(deviceId)),
  });

  const authenticated = new WeakMap<IncomingMessage, DeviceRecord>();
  const phoneAuthResults = new WeakMap<
    IncomingMessage,
    { device: DeviceRecord; desktopId: string }
  >();
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
        onReadyMessage: (link, text) =>
          handleDesktopMessage(registry, link, text),
        onClose: (link) => {
          closeDesktopChannels(registry, link);
        },
      });
    },
  );

  const phoneAuth = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    let device: DeviceRecord;
    try {
      device = authenticateBearer(options.store, request.headers);
    } catch (error: unknown) {
      if (error instanceof AuthError) {
        sendError(reply, 401, 'UNAUTHENTICATED');
        return;
      }
      throw error;
    }
    const query = request.query as Record<string, unknown>;
    const desktopId = query['desktopId'];
    if (typeof desktopId !== 'string' || desktopId.length === 0) {
      sendError(reply, 400, 'INVALID_REQUEST');
      return;
    }
    const target = options.store.findDevice(desktopId);
    if (
      target === null ||
      target.role !== 'desktop' ||
      target.accountId !== device.accountId
    ) {
      sendError(reply, 404, 'DESKTOP_NOT_FOUND');
      return;
    }
    if (!registry.isOnline(desktopId)) {
      sendError(reply, 503, 'DESKTOP_OFFLINE');
      return;
    }
    phoneAuthResults.set(request.raw, { device, desktopId });
  };

  const handlePhone =
    (kind: 'control' | 'asr') =>
    (socket: WebSocket, request: FastifyRequest): void => {
      const context = phoneAuthResults.get(request.raw);
      if (context === undefined) {
        socket.close();
        return;
      }
      acceptPhoneChannel({
        socket,
        device: context.device,
        desktopId: context.desktopId,
        kind,
        registry,
        limits,
      });
    };

  app.get('/ws', { websocket: true, preValidation: phoneAuth }, handlePhone('control'));
  app.get(
    '/ws/asr',
    { websocket: true, preValidation: phoneAuth },
    handlePhone('asr'),
  );

  app.setNotFoundHandler(async (_request, reply) =>
    sendError(reply, 404, 'ROUTE_NOT_FOUND'),
  );

  return app;
}