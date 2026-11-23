import { randomBytes } from 'node:crypto';

import { WebSocket } from 'ws';

import { AgentLogger } from '../app/logger.js';

const DESKTOP_PATH = '/v1/desktop/ws';
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HANDSHAKE_ID_BYTES = 9;
/** 4000 被取代（另一实例持有身份）/ 4002 版本不兼容 / 4004 已吊销：不再重连。 */
const FATAL_CLOSE_CODES = new Set([4000, 4002, 4004]);
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_JITTER = 0.2;

/** 桌面端 hello 载荷（契约 §5.1）。 */
export interface RelayLinkHello {
  appVersion: string;
  desktopName: string;
  platform: string;
  supportedContractVersions: number[];
}

/** relay 链路回调；与契约 §5.2/§5.4 入站消息一一对应。 */
export interface RelayLinkHandlers {
  onReady(info: { epoch: number }): void;
  onChannelOpen(input: {
    channelId: string;
    kind: 'control' | 'asr';
    deviceId: string;
    appVersion?: string;
  }): void;
  onChannelData(input: {
    channelId: string;
    data: string;
    binary: boolean;
  }): void;
  onChannelClose(input: {
    channelId: string;
    code: number;
    reason: string;
  }): void;
  onHttpRequest(input: {
    requestId: string;
    deviceId: string;
    method: string;
    path: string;
    contentType?: string;
    body: Buffer;
  }): void;
}

/** 重连退避参数；测试可缩短。 */
export interface RelayBackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitter?: number;
}

/** RelayLink 构造选项。 */
export interface RelayLinkOptions {
  baseUrl: string;
  credential: { deviceId: string; deviceToken: string };
  hello: RelayLinkHello;
  handlers: RelayLinkHandlers;
  logger: AgentLogger;
  backoff?: RelayBackoffOptions;
  webSocketFactory?: (
    url: string,
    headers: Record<string, string>,
  ) => WebSocket;
}

/** 链路状态；lastError 为致命关闭码或 null。 */
export interface RelayLinkState {
  status: 'connecting' | 'ready' | 'stopped';
  lastEpoch: number | null;
  lastError: string | null;
}

/** 出站链路句柄。 */
export interface RelayLink {
  channelData(channelId: string, data: string | Uint8Array): void;
  channelClose(channelId: string, code: number, reason: string): void;
  httpResponse(
    requestId: string,
    response: { status: number; contentType?: string; body: Buffer },
  ): void;
  state(): RelayLinkState;
  stop(): void;
}

/** 建立（并维护）到云端 relay 的出站连接。 */
export function startRelayLink(options: RelayLinkOptions): RelayLink {
  const { handlers, logger } = options;
  const wsUrl = `${options.baseUrl.replace(/^http/, 'ws')}${DESKTOP_PATH}`;
  const authorization = `Bearer ${options.credential.deviceId}.${options.credential.deviceToken}`;
  const factory =
    options.webSocketFactory ??
    ((url, headers) => new WebSocket(url, { headers }));

  let socket: WebSocket | null = null;
  let status: RelayLinkState['status'] = 'connecting';
  let lastEpoch: number | null = null;
  let lastError: string | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  };

  const reconnectDelayMs = (): number => {
    const baseMs = options.backoff?.baseMs ?? DEFAULT_BACKOFF_MS;
    const maxMs = options.backoff?.maxMs ?? DEFAULT_MAX_BACKOFF_MS;
    const jitter = options.backoff?.jitter ?? DEFAULT_JITTER;
    const base = Math.min(baseMs * 2 ** attempt, maxMs);
    attempt += 1;
    const factor = 1 + (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(base * factor));
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    const delay = reconnectDelayMs();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  function connect(): void {
    if (stopped) return;
    let current: WebSocket;
    try {
      current = factory(wsUrl, { authorization });
    } catch (error: unknown) {
      logger.warn('relay.connect_failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      scheduleReconnect();
      return;
    }
    socket = current;

    current.on('open', () => {
      current.send(
        JSON.stringify({
          type: 'desktop.hello',
          payload: {
            ...options.hello,
            handshakeId: `hs_${randomBytes(HANDSHAKE_ID_BYTES).toString('base64url')}`,
          },
        }),
      );
      handshakeTimer = setTimeout(() => {
        handshakeTimer = null;
        current.terminate();
      }, HANDSHAKE_TIMEOUT_MS);
    });

    current.on('message', (data: unknown) => {
      handleMessage(String(data));
    });

    current.on('close', (code: number) => {
      if (socket !== current) return;
      socket = null;
      clearTimers();
      if (stopped) return;
      if (FATAL_CLOSE_CODES.has(code)) {
        status = 'stopped';
        lastError = String(code);
        logger.warn('relay.fatal_close', { code });
        return;
      }
      status = 'connecting';
      logger.warn('relay.disconnected', { code });
      scheduleReconnect();
    });

    current.on('error', () => {
      // ws 在 error 后必发 close，由 close 处理器统一调度重连。
    });
  }

  function handleMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warn('relay.invalid_message', { reason: 'json' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      logger.warn('relay.invalid_message', { reason: 'shape' });
      return;
    }
    const message = parsed as { type?: unknown; payload?: unknown };
    if (typeof message.type !== 'string') return;

    if (status !== 'ready' && message.type === 'desktop.ready') {
      const payload = message.payload as { connectionEpoch?: unknown };
      const epoch =
        typeof payload?.connectionEpoch === 'number'
          ? payload.connectionEpoch
          : 0;
      status = 'ready';
      attempt = 0;
      lastEpoch = epoch;
      if (handshakeTimer !== null) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
      handlers.onReady({ epoch });
      return;
    }
    if (message.type === 'error') {
      const payload = message.payload as { error?: { code?: unknown } };
      logger.warn('relay.error', {
        code:
          typeof payload?.error?.code === 'string' ? payload.error.code : null,
      });
      return;
    }
    if (status !== 'ready') return;

    if (message.type === 'channel.open') {
      const input = parseChannelOpen(message.payload);
      if (input === null) {
        logger.warn('relay.invalid_message', { type: message.type });
        return;
      }
      handlers.onChannelOpen(input);
      return;
    }
    if (message.type === 'channel.data') {
      const input = parseChannelData(message.payload);
      if (input === null) {
        logger.warn('relay.invalid_message', { type: message.type });
        return;
      }
      handlers.onChannelData(input);
      return;
    }
    if (message.type === 'channel.close') {
      const input = parseChannelClose(message.payload);
      if (input === null) {
        logger.warn('relay.invalid_message', { type: message.type });
        return;
      }
      handlers.onChannelClose(input);
      return;
    }
    if (message.type === 'http.request') {
      const input = parseHttpRequest(message.payload);
      if (input === null) {
        logger.warn('relay.invalid_message', { type: message.type });
        return;
      }
      handlers.onHttpRequest(input);
      return;
    }
  }

  function sendMessage(message: Record<string, unknown>): void {
    const current = socket;
    if (
      current === null ||
      status !== 'ready' ||
      current.readyState !== WebSocket.OPEN
    ) {
      logger.info('relay.send_dropped', { type: message['type'] });
      return;
    }
    current.send(JSON.stringify(message));
  }

  connect();

  return {
    channelData(channelId, data) {
      if (typeof data === 'string') {
        sendMessage({
          type: 'channel.data',
          payload: { channelId, binary: false, data },
        });
        return;
      }
      sendMessage({
        type: 'channel.data',
        payload: {
          channelId,
          binary: true,
          data: Buffer.from(data).toString('base64'),
        },
      });
    },
    channelClose(channelId, code, reason) {
      sendMessage({
        type: 'channel.close',
        payload: { channelId, code, reason },
      });
    },
    httpResponse(requestId, response) {
      sendMessage({
        type: 'http.response',
        payload: {
          requestId,
          status: response.status,
          ...(response.contentType === undefined
            ? {}
            : { contentType: response.contentType }),
          bodyBase64: response.body.toString('base64'),
        },
      });
    },
    state: () => ({ status, lastEpoch, lastError }),
    stop() {
      stopped = true;
      status = 'stopped';
      clearTimers();
      const current = socket;
      socket = null;
      current?.terminate();
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function parseChannelOpen(payload: unknown): {
  channelId: string;
  kind: 'control' | 'asr';
  deviceId: string;
  appVersion?: string;
} | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const channelId = record['channelId'];
  const kind = record['kind'];
  const deviceId = record['deviceId'];
  const appVersion = record['appVersion'];
  if (
    typeof channelId !== 'string' ||
    (kind !== 'control' && kind !== 'asr') ||
    typeof deviceId !== 'string'
  ) {
    return null;
  }
  return {
    channelId,
    kind,
    deviceId,
    ...(typeof appVersion === 'string' ? { appVersion } : {}),
  };
}

function parseChannelData(payload: unknown): {
  channelId: string;
  data: string;
  binary: boolean;
} | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const channelId = record['channelId'];
  const data = record['data'];
  const binary = record['binary'];
  if (
    typeof channelId !== 'string' ||
    typeof data !== 'string' ||
    typeof binary !== 'boolean'
  ) {
    return null;
  }
  return { channelId, data, binary };
}

function parseChannelClose(payload: unknown): {
  channelId: string;
  code: number;
  reason: string;
} | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const channelId = record['channelId'];
  const code = record['code'];
  const reason = record['reason'];
  if (
    typeof channelId !== 'string' ||
    typeof code !== 'number' ||
    typeof reason !== 'string'
  ) {
    return null;
  }
  return { channelId, code, reason };
}

function parseHttpRequest(payload: unknown): {
  requestId: string;
  deviceId: string;
  method: string;
  path: string;
  contentType?: string;
  body: Buffer;
} | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const requestId = record['requestId'];
  const deviceId = record['deviceId'];
  const method = record['method'];
  const path = record['path'];
  const contentType = record['contentType'];
  const bodyBase64 = record['bodyBase64'];
  if (
    typeof requestId !== 'string' ||
    typeof deviceId !== 'string' ||
    typeof method !== 'string' ||
    typeof path !== 'string' ||
    (contentType !== undefined && typeof contentType !== 'string') ||
    (bodyBase64 !== undefined && typeof bodyBase64 !== 'string')
  ) {
    return null;
  }
  return {
    requestId,
    deviceId,
    method,
    path,
    ...(contentType === undefined ? {} : { contentType }),
    body: Buffer.from(bodyBase64 ?? '', 'base64'),
  };
}