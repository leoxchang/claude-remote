import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { RelayStore, StoreError } from '../storage/store.js';
import { sendError } from '../http/send-error.js';
import { CONTRACT_VERSION } from '../version.js';
import { SlidingWindowLimiter } from './rate-limiter.js';

const RATE_LIMIT_WINDOW_MS = 60_000;

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  clientType: z.enum(['phone', 'desktop']),
  deviceName: z.string().min(1),
  platform: z.enum(['ios', 'android', 'macos', 'linux']),
  appVersion: z.string().min(1),
});

/** 登录路由依赖。 */
export interface LoginRouteDeps {
  store: RelayStore;
  loginPerMinute: number;
}

/** 注册 POST /v1/auth/login；限流先于验口令，失败尝试同样计数。 */
export function registerLoginRoute(
  app: FastifyInstance,
  deps: LoginRouteDeps,
): void {
  const limiter = new SlidingWindowLimiter(
    deps.loginPerMinute,
    RATE_LIMIT_WINDOW_MS,
  );

  app.post('/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST');
    const input = parsed.data;

    if (!limiter.allow(`${input.username}|${request.ip}`)) {
      return sendError(reply, 429, 'RATE_LIMITED');
    }

    const account = deps.store.verifyPassword(input.username, input.password);
    if (account === null) return sendError(reply, 401, 'INVALID_CREDENTIALS');
    if (account.disabled) return sendError(reply, 403, 'ACCOUNT_DISABLED');

    try {
      const created = deps.store.createDevice({
        accountId: account.accountId,
        role: input.clientType,
        deviceName: input.deviceName,
        platform: input.platform,
        appVersion: input.appVersion,
      });
      return reply.code(200).send({
        accountId: account.accountId,
        deviceId: created.device.deviceId,
        deviceToken: created.deviceToken,
        role: created.device.role,
        contractVersion: CONTRACT_VERSION,
      });
    } catch (error: unknown) {
      if (error instanceof StoreError && error.code === 'DEVICE_LIMIT_REACHED') {
        return sendError(reply, 409, 'DEVICE_LIMIT_REACHED');
      }
      throw error;
    }
  });
}