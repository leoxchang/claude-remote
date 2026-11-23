import { z } from 'zod';

import { DesktopLink } from '../routing/registry.js';
import { newPrefixedId } from '../security/credentials.js';

/** 代答失败码；映射为 504/503/502。 */
export type TunnelErrorCode =
  | 'GATEWAY_TIMEOUT'
  | 'DESKTOP_OFFLINE'
  | 'GATEWAY_ERROR';

/** 代答失败。 */
export class TunnelError extends Error {
  constructor(readonly code: TunnelErrorCode) {
    super(code);
    this.name = 'TunnelError';
  }
}

/** 隧道所需上限；来自 RelayLimits。 */
export interface HttpTunnelLimits {
  httpTimeoutMs: number;
  httpBodyBytes: number;
}

/** 发往桌面的代答请求输入。 */
export interface HttpTunnelRequestInput {
  deviceId: string;
  method: string;
  path: string;
  contentType?: string;
  body?: Buffer;
}

/** 桌面返回的代答响应。 */
export interface HttpTunnelResponse {
  status: number;
  contentType?: string;
  body: Buffer;
}

const responseSchema = z.object({
  requestId: z.string().min(1),
  status: z.number().int(),
  contentType: z.string().optional(),
  bodyBase64: z.string().optional(),
});

interface Pending {
  desktopId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(response: HttpTunnelResponse): void;
  reject(error: unknown): void;
}

/** HTTP 代答：requestId 关联 pending，超时/断开/超限映射为稳定错误码。 */
export class HttpTunnel {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly limits: HttpTunnelLimits) {}

  request(
    desktop: DesktopLink,
    input: HttpTunnelRequestInput,
  ): Promise<HttpTunnelResponse> {
    const requestId = newPrefixedId('req_');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new TunnelError('GATEWAY_TIMEOUT'));
      }, this.limits.httpTimeoutMs);
      this.pending.set(requestId, {
        desktopId: desktop.desktopId,
        timer,
        resolve,
        reject,
      });
      desktop.send({
        type: 'http.request',
        payload: {
          requestId,
          deviceId: input.deviceId,
          method: input.method,
          path: input.path,
          ...(input.contentType === undefined
            ? {}
            : { contentType: input.contentType }),
          ...(input.body === undefined
            ? {}
            : { bodyBase64: input.body.toString('base64') }),
        },
      });
    });
  }

  /** 处理 http.response 载荷；未知/迟到 requestId 丢弃并返回已处理。 */
  handleResponse(payload: unknown): boolean {
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) return false;
    const { requestId } = parsed.data;
    const pending = this.pending.get(requestId);
    if (pending === undefined) return true;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    const body = Buffer.from(parsed.data.bodyBase64 ?? '', 'base64');
    if (body.byteLength > this.limits.httpBodyBytes) {
      pending.reject(new TunnelError('GATEWAY_ERROR'));
      return true;
    }
    pending.resolve({
      status: parsed.data.status,
      ...(parsed.data.contentType === undefined
        ? {}
        : { contentType: parsed.data.contentType }),
      body,
    });
    return true;
  }

  /** 桌面断开时只 reject 该桌面的 pending。 */
  failDesktop(desktopId: string): void {
    for (const [requestId, pending] of [...this.pending.entries()]) {
      if (pending.desktopId !== desktopId) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new TunnelError('DESKTOP_OFFLINE'));
    }
  }
}

/** 分流桌面 http.response 消息；非 http.response 返回 false。 */
export function handleHttpResponseMessage(
  tunnel: HttpTunnel,
  text: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const message = parsed as { type?: unknown; payload?: unknown };
  if (message.type !== 'http.response') return false;
  return tunnel.handleResponse(message.payload);
}