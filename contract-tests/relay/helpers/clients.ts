import { WebSocket } from 'ws';

import { RelayHandle, runAdmin } from './harness.js';

/** 设备凭证；Bearer 头格式 `<deviceId>.<deviceToken>`。 */
export interface Credential {
  deviceId: string;
  deviceToken: string;
}

/** 契约 §3.1 登录请求。 */
export interface LoginRequest {
  username: string;
  password: string;
  clientType: 'phone' | 'desktop';
  deviceName: string;
  platform: 'ios' | 'android' | 'macos' | 'linux';
  appVersion: string;
}

/** 契约 §3.1 登录响应。 */
export interface LoginResponse {
  accountId: string;
  deviceId: string;
  deviceToken: string;
  role: 'phone' | 'desktop';
  contractVersion: number;
}

/** 契约 §5.1 桌面 hello 载荷。 */
export interface HelloPayload {
  supportedContractVersions: number[];
  appVersion: string;
  desktopName: string;
  platform: string;
  handshakeId: string;
}

/** 已握手的桌面客户端。 */
export interface DesktopClient {
  epoch: number;
  socket: WebSocket;
  nextMessage(timeoutMs?: number): Promise<Record<string, unknown>>;
  send(message: Record<string, unknown>): void;
  close(): void;
}

const DEFAULT_MESSAGE_TIMEOUT_MS = 5000;

/** 经 admin CLI 创建账号。 */
export async function createAccount(
  handle: RelayHandle,
  username: string,
  password: string,
): Promise<void> {
  await runAdmin(handle, [
    'admin',
    'create-user',
    username,
    '--password',
    password,
  ]);
}

/** 登录并返回设备凭证。 */
export async function login(
  baseUrl: string,
  request: LoginRequest,
): Promise<LoginResponse> {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as LoginResponse;
}

/** 桌面角色的登录请求。 */
export function desktopLogin(
  username: string,
  password: string,
  deviceName = 'Contract Mac',
): LoginRequest {
  return {
    username,
    password,
    clientType: 'desktop',
    deviceName,
    platform: 'macos',
    appVersion: '1.0.0',
  };
}

/** 手机角色的登录请求。 */
export function phoneLogin(
  username: string,
  password: string,
  deviceName = 'Contract iPhone',
): LoginRequest {
  return {
    username,
    password,
    clientType: 'phone',
    deviceName,
    platform: 'ios',
    appVersion: '1.0.0',
  };
}

export function bearer(credential: Credential): string {
  return `Bearer ${credential.deviceId}.${credential.deviceToken}`;
}

/** 建立桌面连接并完成 hello/ready 握手。 */
export async function openDesktop(
  baseUrl: string,
  credential: Credential,
  overrides: Partial<HelloPayload> = {},
): Promise<DesktopClient> {
  const socket = await connectWebSocket(
    wsUrl(baseUrl, '/v1/desktop/ws'),
    credential,
  );
  const queue = new MessageQueue(socket);
  socket.send(
    JSON.stringify({
      type: 'desktop.hello',
      payload: {
        supportedContractVersions: [1],
        appVersion: '1.0.0',
        desktopName: 'Contract Mac',
        platform: 'macos',
        handshakeId: `hs_${Math.random().toString(36).slice(2, 10)}`,
        ...overrides,
      },
    }),
  );
  const ready = await queue.next(10000);
  if (ready['type'] !== 'desktop.ready') {
    throw new Error(`expected desktop.ready, got ${JSON.stringify(ready)}`);
  }
  const payload = ready['payload'] as { connectionEpoch?: number };
  return {
    epoch: payload.connectionEpoch ?? -1,
    socket,
    nextMessage: (timeoutMs) =>
      queue.next(timeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS),
    send: (message) => {
      socket.send(JSON.stringify(message));
    },
    close: () => {
      socket.close();
    },
  };
}

/** 打开手机通道连接；升级失败时抛带 statusCode 的错误。 */
export function openPhone(
  baseUrl: string,
  credential: Credential,
  desktopId: string,
  kind: 'control' | 'asr',
): Promise<WebSocket> {
  return connectWebSocket(
    wsUrl(baseUrl, phonePath(desktopId, kind)),
    credential,
  );
}

/** 尝试打开手机通道，升级被拒时返回状态码而不抛错。 */
export async function attemptPhone(
  baseUrl: string,
  credential: Credential,
  desktopId: string,
  kind: 'control' | 'asr',
): Promise<{ ok: true; socket: WebSocket } | { ok: false; status: number }> {
  try {
    const socket = await openPhone(baseUrl, credential, desktopId, kind);
    return { ok: true, socket };
  } catch (error: unknown) {
    const status = (error as { statusCode?: number }).statusCode;
    return { ok: false, status: status ?? -1 };
  }
}

/** 取手机连接的下一帧（文本或二进制）。 */
export function nextPhoneFrame(
  socket: WebSocket,
  timeoutMs = 5000,
): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolveFrame, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), timeoutMs);
    socket.once('message', (data, isBinary: boolean) => {
      clearTimeout(timer);
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
      resolveFrame({ data: buffer, isBinary });
    });
  });
}

/** 取手机连接的下一条文本帧。 */
export async function nextPhoneText(
  socket: WebSocket,
  timeoutMs = 5000,
): Promise<string> {
  const frame = await nextPhoneFrame(socket, timeoutMs);
  return frame.data.toString('utf8');
}

/** 断言 socket 以指定 code 关闭。 */
export function expectClose(
  socket: WebSocket,
  code: number,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    socket.once('close', (actual: number) => {
      clearTimeout(timer);
      if (actual === code) {
        resolveClose();
        return;
      }
      reject(new Error(`expected close ${code}, got ${actual}`));
    });
  });
}

/** 契约 §3.2 查询桌面列表。 */
export async function listDesktops(
  baseUrl: string,
  credential: Credential,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${baseUrl}/v1/desktops`, {
    headers: { authorization: bearer(credential) },
  });
  if (response.status !== 200) {
    throw new Error(`desktops failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    desktops: Array<Record<string, unknown>>;
  };
  return body.desktops;
}

function phonePath(desktopId: string, kind: 'control' | 'asr'): string {
  const suffix = `?desktopId=${encodeURIComponent(desktopId)}`;
  return kind === 'control' ? `/ws${suffix}` : `/ws/asr${suffix}`;
}

function wsUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/^http/, 'ws')}${path}`;
}

function connectWebSocket(
  url: string,
  credential: Credential,
  options: { autoPong?: boolean } = {},
): Promise<WebSocket> {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url, {
      headers: { authorization: bearer(credential) },
      ...(options.autoPong === undefined ? {} : { autoPong: options.autoPong }),
    });
    socket.once('open', () => resolveSocket(socket));
    socket.once('unexpected-response', (_request, response) => {
      const error = new Error(`upgrade rejected: ${response.statusCode}`);
      reject(Object.assign(error, { statusCode: response.statusCode }));
    });
    socket.once('error', reject);
  });
}

/** 按到达顺序取 JSON 消息；超时或先关闭则拒绝。 */
class MessageQueue {
  private readonly queued: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<(message: Record<string, unknown>) => void> =
    [];
  private closed = false;

  constructor(socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter(message);
        return;
      }
      this.queued.push(message);
    });
    socket.on('close', () => {
      this.closed = true;
    });
  }

  next(timeoutMs: number): Promise<Record<string, unknown>> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error('socket closed'));
    return new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('message timeout'));
      }, timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolveMessage(message);
      });
    });
  }
}