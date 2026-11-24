import { FastifyInstance } from 'fastify';

import { DeviceRecord, RelayStore } from '../storage/store.js';
import { ADMIN_PAGE_HTML } from './admin-page.js';

/** admin HTTP 路由依赖；回调语义与 admin socket 一致。 */
export interface AdminHttpOptions {
  store: RelayStore;
  token: string;
  onAccountDisabled?(accountId: string): void;
  onDeviceRevoked?(device: DeviceRecord): void;
}

/** RELAY_ADMIN_TOKEN 规范化：未设置或 trim 后长度 < 16 → undefined（fail-closed）。 */
export function adminTokenFromEnv(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length < MIN_ADMIN_TOKEN_LENGTH) return undefined;
  return trimmed;
}

const MIN_ADMIN_TOKEN_LENGTH = 16;

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
}
