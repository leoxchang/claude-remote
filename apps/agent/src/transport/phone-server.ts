import { IncomingMessage } from 'node:http';

import websocket from '@fastify/websocket';
import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import { WebSocket } from 'ws';

import { ApprovalContentController } from '../approval/approval-content-controller.js';
import {
  AttachmentStore,
  MAX_ATTACHMENT_BYTES,
} from '../attachment/attachment-store.js';
import { DeviceRecord } from '../domain/types.js';
import {
  PairingError,
  PairingErrorCode,
  PairingInput,
  PairingService,
} from '../pairing/pairing-service.js';
import { RunPromptController } from '../run/run-prompt-controller.js';
import { DeviceStorePort } from '../store/device-store.js';
import { authenticateRequest, authenticateUpgrade } from './authenticate.js';
import {
  handleApprovalContentRead,
  handleAttachmentUpload,
  handleRunPromptRead,
  HttpHandlerResult,
} from './http-handlers.js';

/** 手机接口只监听 localhost；由运行时显式 listen。 */
export const PHONE_LISTEN = { host: '127.0.0.1', port: 8787 } as const;

/** 单条协议消息上限。 */
const MAX_MESSAGE_BYTES = 64 * 1024;

/** 上传请求体上限：8 MiB 图片的 base64 编码再加一点余量。 */
const MAX_ATTACHMENT_BODY_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 4096;

const UNAUTHORIZED_STATUS = 401;

const PAIRING_HTTP_STATUS: Record<PairingErrorCode, number> = {
  PAIRING_FAILED: 400,
  PAIRING_EXPIRED: 410,
  DEVICE_ALREADY_PAIRED: 409,
  RATE_LIMITED: 429,
  VERSION_INCOMPATIBLE: 409,
};

/** 连接诊断日志；只记录元数据，不含令牌。 */
export interface ConnectionLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

/** 手机接口依赖；连接建立后交给 Task 5 的连接层。 */
export interface PhoneServerDependencies {
  pairingService: PairingService;
  deviceStore: DeviceStorePort;
  workspace: { workspaceId: string; displayName: string };
  onConnection: (socket: WebSocket, device: DeviceRecord) => void;
  /** 审批内容读取；未装配时该路由返回 APPROVAL_NOT_FOUND。 */
  approvalContent?: ApprovalContentController;
  /** run prompt 读取；未装配时该路由返回 RUN_NOT_FOUND。 */
  runPrompt?: RunPromptController;
  /** 图片附件存储；未装配时上传路由返回 ATTACHMENT_UNAVAILABLE。 */
  attachments?: AttachmentStore;
  /** 连接诊断；未装配时静默。 */
  logger?: ConnectionLogger;
}

/** 创建手机 HTTP/WSS 入口，不在 101 之前接受未认证升级。 */
export async function createPhoneServer(
  deps: PhoneServerDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const authenticated = new WeakMap<IncomingMessage, DeviceRecord>();

  await app.register(websocket, {
    options: {
      maxPayload: MAX_MESSAGE_BYTES,
      verifyClient: (info, done) => {
        deps.logger?.info('connection.upgrade_attempt', {
          remoteAddress: info.req.socket.remoteAddress ?? null,
        });
        void authenticateUpgrade(info.req.headers, deps.deviceStore).then(
          (device) => {
            authenticated.set(info.req, device);
            done(true);
          },
          () => {
            deps.logger?.warn('connection.rejected', {
              reason: 'unauthenticated',
            });
            done(false, UNAUTHORIZED_STATUS, 'Unauthorized');
          },
        );
      },
    },
  });

  app.post('/v1/pairings', async (request, reply) => {
    const body = request.body;
    if (!isPairingInput(body)) {
      return sendError(reply, 400, 'INVALID_MESSAGE');
    }
    try {
      const result = await deps.pairingService.consume(body);
      return reply.code(201).send({ ...result, workspace: deps.workspace });
    } catch (error: unknown) {
      if (error instanceof PairingError) {
        return sendError(reply, PAIRING_HTTP_STATUS[error.code], error.code);
      }
      throw error;
    }
  });

  app.get('/ws', { websocket: true }, (socket, request) => {
    const device = authenticated.get(request.raw);
    if (device === undefined) {
      deps.logger?.warn('connection.rejected', {
        reason: 'missing_upgrade_auth',
      });
      socket.close();
      return;
    }
    deps.onConnection(socket, device);
  });

  app.get('/v1/approvals/:approvalId/content', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const device = await authenticateRequest(
      request.headers as Record<string, unknown>,
      deps.deviceStore,
    ).catch(() => null);
    if (device === null) {
      return sendError(reply, 401, 'UNAUTHENTICATED');
    }
    const params = request.params as { approvalId?: unknown };
    const approvalId = params.approvalId;
    if (typeof approvalId !== 'string') {
      return sendError(reply, 400, 'INVALID_MESSAGE');
    }
    return sendHandlerResult(
      reply,
      handleApprovalContentRead(
        { approvalContent: deps.approvalContent },
        {
          deviceId: device.deviceId,
          approvalId,
          query: request.query as Record<string, unknown>,
        },
      ),
    );
  });

  app.post(
    '/v1/attachments',
    { bodyLimit: MAX_ATTACHMENT_BODY_BYTES },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const device = await authenticateRequest(
        request.headers as Record<string, unknown>,
        deps.deviceStore,
      ).catch(() => null);
      if (device === null) {
        return sendError(reply, 401, 'UNAUTHENTICATED');
      }
      return sendHandlerResult(
        reply,
        handleAttachmentUpload(
          { attachments: deps.attachments },
          { deviceId: device.deviceId, payload: request.body },
        ),
      );
    },
  );

  app.get('/v1/runs/:runId/prompt', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const device = await authenticateRequest(
      request.headers as Record<string, unknown>,
      deps.deviceStore,
    ).catch(() => null);
    if (device === null) {
      return sendError(reply, 401, 'UNAUTHENTICATED');
    }
    const params = request.params as { runId?: unknown };
    const runId = params.runId;
    if (typeof runId !== 'string') {
      return sendError(reply, 400, 'INVALID_MESSAGE');
    }
    return sendHandlerResult(
      reply,
      handleRunPromptRead({ runPrompt: deps.runPrompt }, { deviceId: device.deviceId, runId }),
    );
  });

  return app;
}

/** 统一输出处理器结果。 */
function sendHandlerResult(
  reply: FastifyReply,
  result: HttpHandlerResult,
): FastifyReply {
  return reply
    .code(result.status)
    .header('content-type', result.contentType)
    .send(result.body);
}

function isPairingInput(value: unknown): value is PairingInput {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['pairingId'] === 'string' &&
    typeof record['code'] === 'string' &&
    typeof record['deviceName'] === 'string' &&
    typeof record['appVersion'] === 'string' &&
    Array.isArray(record['supportedProtocolVersions']) &&
    record['supportedProtocolVersions'].every(
      (version) => typeof version === 'number',
    )
  );
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
): FastifyReply {
  return reply.code(statusCode).send({ error: { code, message: code } });
}