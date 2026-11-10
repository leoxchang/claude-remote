import { negotiateProtocolVersion } from '@claude-remote/protocol/handshake';
import { ProtocolMessage } from '@claude-remote/protocol/types';
import { WebSocket } from 'ws';

import { DeviceRecord } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';
import { BoundedSender } from './bounded-sender.js';
import {
  createReadyMessage,
  HandshakeError,
  parseHelloMessage,
} from './handshake.js';

/** 首条消息必须在 10 秒内到达。 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** 心跳发送间隔。 */
export const PING_INTERVAL_MS = 15_000;

/** 无 pong 的失效上限。 */
export const PONG_TIMEOUT_MS = 45_000;

const MAX_SOCKET_BUFFER = 2 * 1024 * 1024;
const MESSAGE_ID_BYTES = 9;

const CLOSE_SUPERSEDED = 4000;
const CLOSE_HANDSHAKE_FAILED = 4001;
const CLOSE_VERSION_INCOMPATIBLE = 4002;
const CLOSE_SLOW_CONSUMER = 4003;
const CLOSE_REVOKED = 4004;
const CLOSE_SOCKET_ERROR = 4005;

/** 连接层依赖；命令与压力回调由上层注入。 */
export interface ConnectionManagerOptions {
  desktopId: string;
  versions: { agent: string; sdk: string; runtime: string };
  capabilities: string[];
  onDeltaPressure?: (deviceId: string) => void;
  onCommand?: (deviceId: string, raw: string) => void;
}

interface Connection {
  socket: WebSocket;
  deviceId: string;
  epoch: number;
  sender: BoundedSender;
  ready: boolean;
  handshakeTimer: ReturnType<typeof setTimeout>;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  lastPongAt: number;
}

/** 管理已认证的 WSS 连接：握手、心跳、连接代次与有界发送。 */
export class ConnectionManager {
  private readonly connections = new Map<string, Connection>();
  private readonly epochs = new Map<string, number>();

  constructor(private readonly options: ConnectionManagerOptions) {}

  /** 接受到达的手机连接；同设备新连接会使旧连接失效。 */
  async accept(socket: WebSocket, device: DeviceRecord): Promise<void> {
    const epoch = (this.epochs.get(device.deviceId) ?? 0) + 1;
    this.epochs.set(device.deviceId, epoch);

    const previous = this.connections.get(device.deviceId);
    if (previous !== undefined) {
      this.close(previous, CLOSE_SUPERSEDED, 'superseded');
    }

    const connection: Connection = {
      socket,
      deviceId: device.deviceId,
      epoch,
      sender: new BoundedSender(() => {
        this.options.onDeltaPressure?.(device.deviceId);
      }),
      ready: false,
      handshakeTimer: setTimeout(() => {
        this.close(connection, CLOSE_HANDSHAKE_FAILED, 'handshake timeout');
      }, HANDSHAKE_TIMEOUT_MS),
      heartbeatTimer: null,
      lastPongAt: Date.now(),
    };
    connection.sender.attach((data) => this.write(connection, data));
    this.connections.set(device.deviceId, connection);

    socket.on('message', (data: unknown) => {
      this.onMessage(connection, data);
    });
    socket.on('pong', () => {
      connection.lastPongAt = Date.now();
    });
    socket.on('close', () => {
      this.forget(connection);
    });
    socket.on('error', () => {
      this.close(connection, CLOSE_SOCKET_ERROR, 'socket error');
    });
  }

  /** 向所有已完成握手的连接广播协议消息。 */
  publish(event: ProtocolMessage): void {
    for (const connection of [...this.connections.values()]) {
      if (!connection.ready) continue;
      if (connection.sender.send(event) === 'closed') {
        this.close(connection, CLOSE_SLOW_CONSUMER, 'slow consumer');
      }
    }
  }

  /** 吊销设备：立即关闭连接，不影响正在执行的 run。 */
  revoke(deviceId: string): void {
    const connection = this.connections.get(deviceId);
    if (connection !== undefined) {
      this.close(connection, CLOSE_REVOKED, 'revoked');
    }
  }

  /** 当前连接代次；从未连接过为 0。 */
  currentEpoch(deviceId: string): number {
    return this.epochs.get(deviceId) ?? 0;
  }

  private onMessage(connection: Connection, data: unknown): void {
    const raw = toText(data);
    if (!connection.ready) {
      this.handleHandshake(connection, raw);
      return;
    }
    this.options.onCommand?.(connection.deviceId, raw);
  }

  private handleHandshake(connection: Connection, raw: string): void {
    let hello;
    try {
      hello = parseHelloMessage(raw);
    } catch (error: unknown) {
      if (error instanceof HandshakeError) {
        this.close(connection, CLOSE_HANDSHAKE_FAILED, 'invalid hello');
        return;
      }
      throw error;
    }

    const result = negotiateProtocolVersion(hello);
    if (!result.accepted) {
      connection.sender.send(this.errorMessage('VERSION_INCOMPATIBLE'));
      this.close(
        connection,
        CLOSE_VERSION_INCOMPATIBLE,
        'version incompatible',
      );
      return;
    }

    connection.ready = true;
    clearTimeout(connection.handshakeTimer);
    connection.sender.send(
      createReadyMessage({
        desktopId: this.options.desktopId,
        connectionEpoch: connection.epoch,
        versions: this.options.versions,
        capabilities: this.options.capabilities,
        handshakeId: hello.handshakeId,
      }),
    );
    connection.heartbeatTimer = setInterval(() => {
      this.heartbeat(connection);
    }, PING_INTERVAL_MS);
  }

  private heartbeat(connection: Connection): void {
    const now = Date.now();
    if (now - connection.lastPongAt > PONG_TIMEOUT_MS) {
      connection.socket.terminate();
      return;
    }
    connection.socket.ping();
  }

  private write(connection: Connection, data: string): boolean {
    if (connection.socket.readyState !== WebSocket.OPEN) return false;
    if (connection.socket.bufferedAmount >= MAX_SOCKET_BUFFER) return false;
    connection.socket.send(data);
    return true;
  }

  private close(connection: Connection, code: number, reason: string): void {
    this.forget(connection);
    if (
      connection.socket.readyState === WebSocket.OPEN ||
      connection.socket.readyState === WebSocket.CONNECTING
    ) {
      connection.socket.close(code, reason);
    }
  }

  private forget(connection: Connection): void {
    if (this.connections.get(connection.deviceId) === connection) {
      this.connections.delete(connection.deviceId);
    }
    clearTimeout(connection.handshakeTimer);
    if (connection.heartbeatTimer !== null) {
      clearInterval(connection.heartbeatTimer);
      connection.heartbeatTimer = null;
    }
    connection.sender.close();
  }

  private errorMessage(code: string): ProtocolMessage {
    return {
      protocolVersion: 1,
      messageId: `msg_${randomBase64Url(MESSAGE_ID_BYTES)}`,
      timestamp: Date.now(),
      type: 'error',
      payload: { error: { code, message: code } },
    };
  }
}

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data) && data.length === 1 && Buffer.isBuffer(data[0])) {
    return data[0].toString('utf8');
  }
  return String(data);
}