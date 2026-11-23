import Fastify, { FastifyInstance } from 'fastify';

import { DEFAULT_LIMITS, RelayLimits } from './limits.js';

/** 契约定稿版本（relay-contract.md）。 */
export const CONTRACT_VERSION = 1;

/** 当前实现版本，随 GET /v1/version 与 admin 使用。 */
export const RELAY_VERSION = '0.1.0';

/** 创建应用所需依赖与覆盖项；limits 覆盖仅用于测试。 */
export interface RelayAppOptions {
  limits?: Partial<RelayLimits>;
  logger?: boolean;
}

const ERROR_CODE_ROUTE_NOT_FOUND = 'ROUTE_NOT_FOUND';

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

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({
      error: {
        code: ERROR_CODE_ROUTE_NOT_FOUND,
        message: ERROR_CODE_ROUTE_NOT_FOUND,
      },
    }),
  );

  return app;
}