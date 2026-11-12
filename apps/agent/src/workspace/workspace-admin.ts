import { FastifyInstance, FastifyReply } from 'fastify';

import { AgentError } from '../command/errors.js';
import { ConfigV2Error } from '../config/config-v2.js';
import { toSummary } from './workspace-types.js';
import { WorkspaceManager } from './workspace-manager.js';

/** 项目路由依赖；只在 Unix socket 上注册。 */
export interface WorkspaceAdminDependencies {
  workspaces: WorkspaceManager;
}

/** 注册本机项目管理路由；手机协议没有对应 endpoint。 */
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: WorkspaceAdminDependencies,
): void {
  app.get('/admin/v1/workspaces', async () => deps.workspaces.list());

  app.post('/admin/v1/workspaces/add', async (request, reply) => {
    const body = asBody(request.body);
    const path = body['path'];
    const displayName = body['displayName'];
    if (typeof path !== 'string' || typeof displayName !== 'string') {
      return sendError(reply, 400, 'INVALID_MESSAGE');
    }
    try {
      return toSummary(await deps.workspaces.add({ path, displayName }));
    } catch (error: unknown) {
      return sendAdminError(reply, error);
    }
  });

  app.post('/admin/v1/workspaces/rename', async (request, reply) => {
    const body = asBody(request.body);
    const workspaceId = body['workspaceId'];
    const displayName = body['displayName'];
    if (typeof workspaceId !== 'string' || typeof displayName !== 'string') {
      return sendError(reply, 400, 'INVALID_MESSAGE');
    }
    try {
      return await deps.workspaces.rename(workspaceId, displayName);
    } catch (error: unknown) {
      return sendAdminError(reply, error);
    }
  });

  app.post('/admin/v1/workspaces/remove', async (request, reply) => {
    const body = asBody(request.body);
    const workspaceId = body['workspaceId'];
    if (typeof workspaceId !== 'string') {
      return sendError(reply, 400, 'INVALID_MESSAGE');
    }
    try {
      await deps.workspaces.remove(workspaceId);
      return { workspaceId, removed: true };
    } catch (error: unknown) {
      return sendAdminError(reply, error);
    }
  });
}

function sendAdminError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AgentError) {
    const status =
      error.code === 'WORKSPACE_NOT_FOUND'
        ? 404
        : error.code === 'WORKSPACE_BUSY'
          ? 409
          : 400;
    return sendError(reply, status, error.code);
  }
  if (error instanceof ConfigV2Error) {
    return sendError(reply, 409, error.code);
  }
  throw error;
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
): FastifyReply {
  return reply.code(statusCode).send({ error: { code, message: code } });
}

function asBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  return value as Record<string, unknown>;
}