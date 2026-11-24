import { timingSafeEqual } from 'node:crypto';

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sendError } from '../http/send-error.js';
import { DeviceRecord, RelayStore } from '../storage/store.js';
import { AdminResponse, handleAdminRequest } from './admin-socket.js';
import { ADMIN_PAGE_HTML } from './admin-page.js';

/** admin HTTP 路由依赖；回调语义与 admin socket 一致。 */
export interface AdminHttpOptions {
  store: RelayStore;
  token: string;
  onAccountDisabled?(accountId: string): void;
  onDeviceRevoked?(device: DeviceRecord): void;
}

const MIN_ADMIN_TOKEN_LENGTH = 16;

/** RELAY_ADMIN_TOKEN 规范化：未设置或 trim 后长度 < 16 → undefined（fail-closed）。 */
export function adminTokenFromEnv(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length < MIN_ADMIN_TOKEN_LENGTH) return undefined;
  return trimmed;
}

/** AdminResponse 错误码 → HTTP 状态；与 CLI 错误语义对齐。 */
const ADMIN_ERROR_STATUS: Record<string, number> = {
  INVALID_REQUEST: 400,
  ACCOUNT_NOT_FOUND: 404,
  DEVICE_NOT_FOUND: 404,
  USERNAME_TAKEN: 409,
};

const AUTH_SCHEME = 'bearer ';
const AUTH_SCHEME_LENGTH = AUTH_SCHEME.length;

/** 校验 Bearer admin 令牌；失败已回复 401，返回 false。 */
function assertAdminToken(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
): boolean {
  const header = request.headers.authorization;
  if (
    typeof header !== 'string' ||
    header.toLowerCase().startsWith(AUTH_SCHEME) === false
  ) {
    sendError(reply, 401, 'UNAUTHORIZED');
    return false;
  }
  const presented = header.slice(AUTH_SCHEME_LENGTH);
  const expected = Buffer.from(token, 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    sendError(reply, 401, 'UNAUTHORIZED');
    return false;
  }
  return true;
}

/** AdminResponse → HTTP：成功透传，失败按映射表 sendError。 */
function replyAdminResponse(
  reply: FastifyReply,
  response: AdminResponse,
): FastifyReply {
  if (response.ok) return reply.code(200).send(response);
  const status = ADMIN_ERROR_STATUS[response.error.code] ?? 500;
  return sendError(reply, status, response.error.code);
}

/** 注册管理页与管理 API；仅当调用方提供有效令牌时调用。 */
export function registerAdminRoutes(
  app: FastifyInstance,
  options: AdminHttpOptions,
): void {
  app.get('/admin', async (_request, reply) => {
    return reply.header('content-type', 'text/html; charset=utf-8').send(
      ADMIN_PAGE_HTML,
    );
  });

  app.get('/admin/api/accounts', async (request, reply) => {
    if (!assertAdminToken(request, reply, options.token)) return reply;
    const response = handleAdminRequest(options, { op: 'list-accounts' });
    return replyAdminResponse(reply, response);
  });

  app.post('/admin/api/accounts', async (request, reply) => {
    if (!assertAdminToken(request, reply, options.token)) return reply;
    const body = bodyAsObject(request.body);
    if (body === null) return sendError(reply, 400, 'INVALID_REQUEST');
    const response = handleAdminRequest(options, {
      op: 'create-user',
      username: body['username'],
      password: body['password'],
    });
    return replyAdminResponse(reply, response);
  });

  app.post(
    '/admin/api/accounts/:username/disable',
    async (request, reply) => {
      if (!assertAdminToken(request, reply, options.token)) return reply;
      const { username } = request.params as { username: string };
      const response = handleAdminRequest(options, {
        op: 'disable-user',
        username,
      });
      return replyAdminResponse(reply, response);
    },
  );

  app.post(
    '/admin/api/accounts/:username/enable',
    async (request, reply) => {
      if (!assertAdminToken(request, reply, options.token)) return reply;
      const { username } = request.params as { username: string };
      const response = handleAdminRequest(options, {
        op: 'enable-user',
        username,
      });
      return replyAdminResponse(reply, response);
    },
  );

  app.post(
    '/admin/api/accounts/:username/reset-password',
    async (request, reply) => {
      if (!assertAdminToken(request, reply, options.token)) return reply;
      const { username } = request.params as { username: string };
      const body = bodyAsObject(request.body);
      if (body === null) return sendError(reply, 400, 'INVALID_REQUEST');
      const response = handleAdminRequest(options, {
        op: 'reset-password',
        username,
        password: body['password'],
      });
      return replyAdminResponse(reply, response);
    },
  );

  app.get('/admin/api/accounts/:username/devices', async (request, reply) => {
    if (!assertAdminToken(request, reply, options.token)) return reply;
    const { username } = request.params as { username: string };
    const response = handleAdminRequest(options, { op: 'list-devices', username });
    return replyAdminResponse(reply, response);
  });

  app.delete('/admin/api/devices/:deviceId', async (request, reply) => {
    if (!assertAdminToken(request, reply, options.token)) return reply;
    const { deviceId } = request.params as { deviceId: string };
    const response = handleAdminRequest(options, { op: 'revoke-device', deviceId });
    return replyAdminResponse(reply, response);
  });
}

/** 请求体必须是 JSON 对象；数组、原始值与空体一律视为非法请求。 */
function bodyAsObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}
