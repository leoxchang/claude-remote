import { IncomingMessage } from 'node:http';

import websocket from '@fastify/websocket';
import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import { WebSocket } from 'ws';

import { ApprovalContentController } from '../approval/approval-content-controller.js';
import {
  AttachmentStore,
  isImageMediaType,
  MAX_ATTACHMENT_BYTES,
} from '../attachment/attachment-store.js';
import { AgentError } from '../command/errors.js';
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

/** 手机接口只监听 localhost；由运行时显式 listen。 */
export const PHONE_LISTEN = { host: '127.0.0.1', port: 8787 } as const;

/** 单条协议消息上限。 */
const MAX_MESSAGE_BYTES = 64 * 1024;

/** 上传请求体上限：8 MiB 图片的 base64 编码再加一点余量。 */
const MAX_ATTACHMENT_BODY_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 4096;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

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

/** 内容 endpoint 的稳定状态映射。 */
const CONTENT_HTTP_STATUS: Record<string, number> = {
  INVALID_MESSAGE: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_ALREADY_RESOLVED: 409,
  APPROVAL_CONTENT_UNAVAILABLE: 409,
  APPROVAL_EXPIRED: 410,
  RATE_LIMITED: 429,
};

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
    if (deps.approvalContent === undefined) {
      return sendError(reply, 404, 'APPROVAL_NOT_FOUND');
    }
    const params = request.params as { approvalId?: unknown };
    const approvalId = params.approvalId;
    const chunkIndex = parseChunkIndex(
      (request.query as { chunkIndex?: unknown }).chunkIndex,
    );
    if (
      typeof approvalId !== 'string' ||
      approvalId.length === 0 ||
      chunkIndex === null
    ) {
      return sendError(reply, 400, 'INVALID_MESSAGE');
    }
    try {
      return deps.approvalContent.readChunk({
        approvalId,
        chunkIndex,
        deviceId: device.deviceId,
      });
    } catch (error: unknown) {
      if (error instanceof AgentError) {
        const status = CONTENT_HTTP_STATUS[error.code] ?? 409;
        return sendError(reply, status, error.code);
      }
      throw error;
    }
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
      if (deps.attachments === undefined) {
        return sendError(reply, 404, 'ATTACHMENT_UNAVAILABLE');
      }
      const upload = parseAttachmentUpload(request.body);
      if (upload === null) {
        return sendError(reply, 400, 'INVALID_MESSAGE');
      }
      try {
        const saved = deps.attachments.save({
          deviceId: device.deviceId,
          mediaType: upload.mediaType,
          bytes: upload.bytes,
        });
        return reply.code(201).send(saved);
      } catch {
        return sendError(reply, 400, 'INVALID_MESSAGE');
      }
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
    if (deps.runPrompt === undefined) {
      return sendError(reply, 404, 'RUN_NOT_FOUND');
    }
    const params = request.params as { runId?: unknown };
    const runId = params.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      return sendError(reply, 400, 'INVALID_MESSAGE');
    }
    try {
      return deps.runPrompt.read(runId, device.deviceId);
    } catch (error: unknown) {
      if (error instanceof AgentError) {
        const status =
          error.code === 'FORBIDDEN'
            ? 403
            : error.code === 'RUN_NOT_RECOVERABLE'
              ? 409
              : 404;
        return sendError(reply, status, error.code);
      }
      throw error;
    }
  });

  return app;
}

/** 只接受无符号十进制整数；拒绝负数、小数、空格与科学计数法。 */
function parseChunkIndex(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  return Number(value);
}

interface AttachmentUpload {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Buffer;
}

/** 只接受 JSON `{mediaType, dataBase64}`；解码后由存储层再验大小与格式。 */
function parseAttachmentUpload(body: unknown): AttachmentUpload | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const mediaType = record['mediaType'];
  const dataBase64 = record['dataBase64'];
  if (
    !isImageMediaType(mediaType) ||
    typeof dataBase64 !== 'string' ||
    dataBase64.length === 0 ||
    !BASE64_PATTERN.test(dataBase64)
  ) {
    return null;
  }
  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) return null;
  return { mediaType, bytes };
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