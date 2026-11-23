import { RawData, WebSocket } from 'ws';
import { z } from 'zod';

import { RelayLimits } from '../limits.js';
import { DeviceRecord, RelayStore } from '../storage/store.js';
import { CONTRACT_VERSION } from '../version.js';
import { ConnectionRegistry, DesktopLink } from './registry.js';

export const CLOSE_SUPERSEDED = 4000;
export const CLOSE_HANDSHAKE_FAILED = 4001;
export const CLOSE_VERSION_INCOMPATIBLE = 4002;
export const CLOSE_SLOW_CONSUMER = 4003;
export const CLOSE_REVOKED = 4004;

/** 本实现支持的契约版本。 */
export const SUPPORTED_CONTRACT_VERSIONS: readonly number[] = [
  CONTRACT_VERSION,
];

const desktopHelloSchema = z.object({
  type: z.literal('desktop.hello'),
  payload: z.object({
    supportedContractVersions: z.array(z.number().int()),
    appVersion: z.string().min(1),
    desktopName: z.string().min(1),
    platform: z.string().min(1),
    handshakeId: z.string().min(1),
  }),
});

/** 桌面连接依赖；钩子由 Task 7 的通道拼接注入。 */
export interface DesktopConnectionDeps {
  socket: WebSocket;
  device: DeviceRecord;
  store: RelayStore;
  registry: ConnectionRegistry;
  limits: RelayLimits;
  /** 握手后消息钩子；返回 true 表示已处理，否则按 INVALID_MESSAGE 关闭。 */
  onReadyMessage?(link: DesktopLink, text: string): boolean;
  /** 连接关闭钩子；用于关闭该电脑承载的全部手机通道。 */
  onClose?(link: DesktopLink): void;
  onDisconnect?(desktopId: string): void;
}

/** 契约 envelope：error 消息。 */
export function createErrorMessage(code: string): {
  type: 'error';
  payload: { error: { code: string; message: string } };
} {
  return { type: 'error', payload: { error: { code, message: code } } };
}

/** 桌面握手状态机：hello → ready → 心跳；关闭时清理代次与在线状态。 */
export function acceptDesktopConnection(deps: DesktopConnectionDeps): void {
  const { socket, device, store, registry, limits } = deps;
  let link: DesktopLink | null = null;
  let lastPongAt = Date.now();
  let handshakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    closeWith(CLOSE_HANDSHAKE_FAILED, 'handshake timeout');
  }, limits.handshakeTimeoutMs);
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  socket.on('message', (data: RawData) => {
    const text = data.toString('utf8');
    if (link === null) {
      handleHello(text);
      return;
    }
    handleReadyMessage(link, text);
  });
  socket.on('pong', () => {
    lastPongAt = Date.now();
  });
  socket.on('close', () => {
    clearTimers();
    if (link !== null) {
      registry.detachDesktop(link);
      store.touchLastSeen(device.deviceId);
      deps.onClose?.(link);
      deps.onDisconnect?.(device.deviceId);
    }
  });
  socket.on('error', () => {
    socket.terminate();
  });

  function clearTimers(): void {
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function closeWith(code: number, reason: string): void {
    clearTimers();
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close(code, reason);
    }
  }

  function handleHello(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      closeWith(CLOSE_HANDSHAKE_FAILED, 'invalid hello');
      return;
    }
    const hello = desktopHelloSchema.safeParse(parsed);
    if (!hello.success) {
      closeWith(CLOSE_HANDSHAKE_FAILED, 'invalid hello');
      return;
    }
    const accepted = hello.data.payload.supportedContractVersions.some(
      (version) => SUPPORTED_CONTRACT_VERSIONS.includes(version),
    );
    if (!accepted) {
      socket.send(JSON.stringify(createErrorMessage('VERSION_INCOMPATIBLE')));
      closeWith(CLOSE_VERSION_INCOMPATIBLE, 'version incompatible');
      return;
    }
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    const epoch = store.nextConnectionEpoch(device.deviceId);
    link = registry.attachDesktop(device, socket, epoch);
    socket.send(
      JSON.stringify({
        type: 'desktop.ready',
        payload: {
          handshakeId: hello.data.payload.handshakeId,
          contractVersion: CONTRACT_VERSION,
          connectionEpoch: epoch,
        },
      }),
    );
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastPongAt > limits.pongTimeoutMs) {
        socket.terminate();
        return;
      }
      socket.ping();
    }, limits.pingIntervalMs);
  }

  function handleReadyMessage(current: DesktopLink, text: string): void {
    if (deps.onReadyMessage !== undefined && deps.onReadyMessage(current, text)) {
      return;
    }
    socket.send(JSON.stringify(createErrorMessage('INVALID_MESSAGE')));
    closeWith(CLOSE_HANDSHAKE_FAILED, 'invalid message');
  }
}