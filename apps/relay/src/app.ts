import { IncomingMessage } from 'node:http';

import websocket from '@fastify/websocket';
import Fastify, {
  FastifyError,
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
import { acceptDesktopConnection, CLOSE_REVOKED } from './routing/desktop-link.js';
import {
  acceptPhoneChannel,
  closeDesktopChannels,
  handleDesktopMessage,
} from './routing/splice.js';
import { ConnectionRegistry, DesktopLink } from './routing/registry.js';
import { DeviceRecord, RelayStore } from './storage/store.js';
import {
  handleHttpResponseMessage,
  HttpTunnel,
  TunnelError,
  TunnelErrorCode,
} from './tunnel/http-proxy.js';
import { CONTRACT_VERSION, RELAY_VERSION } from './version.js';

export { CONTRACT_VERSION, RELAY_VERSION };

const PROXY_PARAM_PATTERN = /^[A-Za-z0-9_-]+$/;

const TUNNEL_ERROR_STATUS: Record<TunnelErrorCode, number> = {
  GATEWAY_TIMEOUT: 504,
  DESKTOP_OFFLINE: 503,
  GATEWAY_ERROR: 502,
};

const BODY_TOO_LARGE_CODE = 'FST_ERR_CTP_BODY_TOO_LARGE';

/** 转发给桌面的查询参数：排除 desktopId，仅保留字符串值；空则缺省。 */
function forwardedQuery(
  query: unknown,
): Record<string, string> | undefined {
  if (typeof query !== 'object' || query === null) return undefined;
  const forwarded: Record<string, string> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (key === 'desktopId' || typeof value !== 'string') continue;
    forwarded[key] = value;
  }
  return Object.keys(forwarded).length === 0 ? undefined : forwarded;
}

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
  const tunnel = new HttpTunnel({
    httpTimeoutMs: limits.httpTimeoutMs,
    httpBodyBytes: limits.httpBodyBytes,
  });
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
    onRevoke: (device) => {
      registry.closeDevice(device.deviceId, CLOSE_REVOKED);
    },
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
        onReadyMessage: (link, text) => {
          // 旧代次桌面连接的消息一律忽略（契约 §5.1：云端只接受最新代次）。
          if (registry.desktopFor(link.desktopId) !== link) return true;
          return (
            handleHttpResponseMessage(tunnel, text) ||
            handleDesktopMessage(registry, link, text, limits)
          );
        },
        onClose: (link) => {
          closeDesktopChannels(registry, link);
          tunnel.failDesktop(link);
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

  const resolveProxyTarget = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): { device: DeviceRecord; desktop: DesktopLink } | null => {
    let device: DeviceRecord;
    try {
      device = authenticateBearer(options.store, request.headers);
    } catch (error: unknown) {
      if (error instanceof AuthError) {
        sendError(reply, 401, 'UNAUTHENTICATED');
        return null;
      }
      throw error;
    }
    const query = request.query as Record<string, unknown>;
    const desktopId = query['desktopId'];
    if (typeof desktopId !== 'string' || desktopId.length === 0) {
      sendError(reply, 400, 'INVALID_REQUEST');
      return null;
    }
    const target = options.store.findDevice(desktopId);
    if (
      target === null ||
      target.role !== 'desktop' ||
      target.accountId !== device.accountId
    ) {
      sendError(reply, 404, 'DESKTOP_NOT_FOUND');
      return null;
    }
    const desktop = registry.desktopFor(desktopId);
    if (desktop === undefined || !registry.isOnline(desktopId)) {
      sendError(reply, 503, 'DESKTOP_OFFLINE');
      return null;
    }
    return { device, desktop };
  };

  const forwardProxy = async (
    request: FastifyRequest,
    reply: FastifyReply,
    method: 'GET' | 'POST',
    path: string,
    body?: Buffer,
  ): Promise<FastifyReply> => {
    const context = resolveProxyTarget(request, reply);
    if (context === null) return reply;
    const contentType = request.headers['content-type'];
    const query = forwardedQuery(request.query);
    try {
      const response = await tunnel.request(context.desktop, {
        deviceId: context.device.deviceId,
        method,
        path,
        ...(query === undefined ? {} : { query }),
        ...(typeof contentType === 'string' ? { contentType } : {}),
        ...(body === undefined ? {} : { body }),
      });
      if (response.contentType !== undefined) {
        reply.header('content-type', response.contentType);
      }
      return reply.code(response.status).send(response.body);
    } catch (error: unknown) {
      if (error instanceof TunnelError) {
        return sendError(reply, TUNNEL_ERROR_STATUS[error.code], error.code);
      }
      throw error;
    }
  };

  // 错误处理器必须先于子插件注册，否则子上下文不继承（413 等映射会失效）。
  app.setErrorHandler(async (error: FastifyError, _request, reply) => {
    if (error.code === BODY_TOO_LARGE_CODE) {
      return sendError(reply, 413, 'BODY_TOO_LARGE');
    }
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) return sendError(reply, 500, 'INTERNAL_ERROR');
    return sendError(reply, statusCode, 'INVALID_REQUEST');
  });

  // 代答路由需要原始字节；用封装插件挂自定义 body 解析，避免影响登录等 JSON 路由。
  await app.register(async (scope) => {
    const rawBodyParser = (
      _request: FastifyRequest,
      body: Buffer,
      done: (error: Error | null, result?: Buffer) => void,
    ): void => {
      done(null, body);
    };
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, rawBodyParser);

    scope.post('/v1/attachments', async (request, reply) => {
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.alloc(0);
      return forwardProxy(request, reply, 'POST', '/v1/attachments', body);
    });

    scope.get('/v1/approvals/:approvalId/content', async (request, reply) => {
      const { approvalId } = request.params as { approvalId: string };
      if (!PROXY_PARAM_PATTERN.test(approvalId)) {
        return sendError(reply, 404, 'ROUTE_NOT_FOUND');
      }
      return forwardProxy(
        request,
        reply,
        'GET',
        `/v1/approvals/${approvalId}/content`,
      );
    });

    scope.get('/v1/runs/:runId/prompt', async (request, reply) => {
      const { runId } = request.params as { runId: string };
      if (!PROXY_PARAM_PATTERN.test(runId)) {
        return sendError(reply, 404, 'ROUTE_NOT_FOUND');
      }
      return forwardProxy(request, reply, 'GET', `/v1/runs/${runId}/prompt`);
    });
  });

  app.setNotFoundHandler(async (_request, reply) =>
    sendError(reply, 404, 'ROUTE_NOT_FOUND'),
  );

  return app;
}