/**
 * 独立 `/ws/asr` 网关：Bearer 鉴权、一连接一流、限流与有界事件队列。
 *
 * ASR 事件只走这条通道，不进入主控制 WSS、Journal、session seq 或数据库。
 */
import { Buffer } from 'node:buffer';

import { FastifyInstance, FastifyRequest } from 'fastify';

import {
  AsrClientEvent,
  AsrControlMessage,
  AsrError,
  AsrErrorCode,
  validateAsrControlMessage,
} from './asr-protocol.js';

/** 单连接队列上限。 */
const MAX_EVENT_QUEUE = 4;

/** 每设备每分钟 start 上限。 */
const MAX_STARTS_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60_000;

/** 标准音频包上限。 */
const MAX_AUDIO_BYTES = 6400;

/** 队列溢出时的固定关闭原因。 */
const BACKPRESSURE_REASON = 'ASR_BACKPRESSURE';

/** 鉴权完成前允许缓存的上行帧数；超过即丢弃。 */
const MAX_PENDING_FRAMES = 32;

/** Gateway 使用的最小流控制面。 */
export interface AsrStreamControl {
  start(input: { deviceId: string; asrStreamId: string }): Promise<void>;
  write(asrStreamId: string, audio: Uint8Array): void;
  finish(asrStreamId: string): void;
  cancel(asrStreamId: string, reason: string): void;
  cancelAll(reason: string): void;
  setEventSink(listener: (event: AsrClientEvent) => void): void;
}

/** 网关依赖。 */
export interface AsrGatewayOptions {
  authenticate: (
    request: FastifyRequest,
  ) => Promise<{ deviceId: string } | null>;
  manager: AsrStreamControl;
  now?: () => number;
}

interface GatewaySocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface ConnectionState {
  socket: GatewaySocket;
  deviceId: string;
  streamId: string | null;
  ready: boolean;
  finished: boolean;
  terminal: boolean;
  closeAfterFlush: boolean;
  socketClosed: boolean;
  messageIds: Set<string>;
  queue: AsrClientEvent[];
  flushScheduled: boolean;
}

/** 每个连接一个状态；全局只有一个 active stream。 */
export class AsrGateway {
  private readonly authenticate: AsrGatewayOptions['authenticate'];
  private readonly manager: AsrStreamControl;
  private readonly now: () => number;
  private readonly startsByDevice = new Map<string, number[]>();
  private readonly connections = new Set<ConnectionState>();
  private current: ConnectionState | null = null;

  constructor(options: AsrGatewayOptions) {
    this.authenticate = options.authenticate;
    this.manager = options.manager;
    this.now = options.now ?? Date.now;
    this.manager.setEventSink((event) => {
      this.onManagerEvent(event);
    });
  }

  attach(app: FastifyInstance): void {
    app.get('/ws/asr', { websocket: true }, (socket, request) => {
      void this.handleConnection(socket as unknown as GatewaySocket, request);
    });
  }

  closeAll(reason: string): void {
    this.manager.cancelAll(reason);
    for (const state of [...this.connections]) {
      const activeOwner = state === this.current && state.streamId !== null;
      if (activeOwner) continue;
      state.terminal = true;
      this.closeSocket(state, reason);
    }
  }

  private async handleConnection(
    socket: GatewaySocket,
    request: FastifyRequest,
  ): Promise<void> {
    const state: ConnectionState = {
      socket,
      deviceId: '',
      streamId: null,
      ready: false,
      finished: false,
      terminal: false,
      closeAfterFlush: false,
      socketClosed: false,
      messageIds: new Set(),
      queue: [],
      flushScheduled: false,
    };
    const pending: Array<{ data: unknown; isBinary: boolean }> = [];
    let authenticated = false;
    socket.on('message', (data: unknown, isBinary: unknown) => {
      if (!authenticated) {
        if (pending.length < MAX_PENDING_FRAMES) {
          pending.push({ data, isBinary: isBinary === true });
        }
        return;
      }
      this.dispatch(state, data, isBinary === true);
    });
    socket.on('close', () => {
      this.onSocketClosed(state);
    });
    socket.on('error', () => {
      this.onSocketClosed(state);
    });
    const device = await this.authenticate(request).catch(() => null);
    if (device === null) {
      socket.close(1008, 'unauthenticated');
      return;
    }
    state.deviceId = device.deviceId;
    authenticated = true;
    this.connections.add(state);
    for (const frame of pending) this.dispatch(state, frame.data, frame.isBinary);
  }

  private dispatch(
    state: ConnectionState,
    data: unknown,
    isBinary: boolean,
  ): void {
    if (isBinary) {
      this.onBinary(state, data);
    } else {
      this.onText(state, data);
    }
  }

  private onText(state: ConnectionState, data: unknown): void {
    if (state.terminal) return;
    const text = toText(data);
    if (text === null) {
      this.failConnection(state, 'INVALID_MESSAGE', false);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.failConnection(state, 'INVALID_MESSAGE', false);
      return;
    }
    let message: AsrControlMessage;
    try {
      message = validateAsrControlMessage(parsed);
    } catch (error: unknown) {
      const code = error instanceof AsrError ? error.code : 'INVALID_MESSAGE';
      this.failConnection(state, code, false);
      return;
    }
    this.onControl(state, message);
  }

  private onControl(
    state: ConnectionState,
    message: AsrControlMessage,
  ): void {
    if (message.type === 'asr.start') {
      this.onStart(state, message);
      return;
    }
    if (state.streamId === null) {
      this.failConnection(state, 'INVALID_MESSAGE', false);
      return;
    }
    if (message.asrStreamId !== state.streamId) {
      this.failConnection(state, 'ASR_STREAM_CONFLICT', false);
      return;
    }
    if (message.type === 'asr.finish') {
      if (state.finished) return;
      if (!state.ready) {
        state.finished = true;
        this.manager.cancel(state.streamId, 'user');
        this.finishConnection(state, 'cancelled');
        return;
      }
      state.finished = true;
      this.manager.finish(state.streamId);
      return;
    }
    this.manager.cancel(state.streamId, 'user');
    this.finishConnection(state, 'cancelled');
  }

  private onStart(
    state: ConnectionState,
    message: AsrControlMessage & { type: 'asr.start' },
  ): void {
    if (state.messageIds.has(message.messageId)) return;
    state.messageIds.add(message.messageId);
    if (state.streamId !== null) {
      this.failConnection(state, 'ASR_STREAM_CONFLICT', false);
      return;
    }
    if (!this.allowStart(state.deviceId)) {
      this.failConnection(state, 'ASR_RATE_LIMITED', false);
      return;
    }
    state.streamId = message.asrStreamId;
    const previous = this.current;
    this.current = state;
    void this.manager
      .start({ deviceId: state.deviceId, asrStreamId: message.asrStreamId })
      .catch((error: unknown) => {
        if (this.current === state) this.current = previous;
        if (state.terminal) return;
        const code = error instanceof AsrError ? error.code : 'ASR_CONNECTION_FAILED';
        this.failConnection(state, code, false);
      });
  }

  private onBinary(state: ConnectionState, data: unknown): void {
    if (
      state.terminal ||
      !state.ready ||
      state.streamId === null ||
      state.finished
    ) {
      return;
    }
    const bytes = toBytes(data);
    if (
      bytes === null ||
      bytes.length === 0 ||
      bytes.length % 2 !== 0 ||
      bytes.length > MAX_AUDIO_BYTES
    ) {
      this.failConnection(state, 'ASR_INVALID_AUDIO', false);
      this.manager.cancel(state.streamId, 'ASR_INVALID_AUDIO');
      return;
    }
    this.manager.write(state.streamId, bytes);
  }

  private onManagerEvent(event: AsrClientEvent): void {
    const state = this.current;
    if (state === null || state.terminal) return;
    if (state.streamId !== event.asrStreamId) return;
    if (event.type === 'asr.started') state.ready = true;
    this.enqueue(state, event);
  }

  private enqueue(state: ConnectionState, event: AsrClientEvent): void {
    if (state.terminal) return;
    if (event.type === 'asr.partial') {
      const index = state.queue.findIndex(
        (entry) => entry.type === 'asr.partial',
      );
      if (index >= 0) {
        state.queue[index] = event;
      } else {
        state.queue.push(event);
      }
    } else if (event.type === 'asr.final' || event.type === 'asr.error') {
      state.queue = state.queue.filter(
        (entry) => entry.type !== 'asr.partial',
      );
      state.queue.push(event);
    } else {
      state.queue.push(event);
    }
    if (state.queue.length > MAX_EVENT_QUEUE) {
      this.overflow(state);
      return;
    }
    if (event.type === 'asr.closed') {
      state.terminal = true;
      state.closeAfterFlush = true;
    }
    this.scheduleFlush(state);
  }

  private overflow(state: ConnectionState): void {
    if (state.terminal) return;
    const streamId = state.streamId ?? 'asr_unassigned';
    state.terminal = true;
    state.queue = [];
    if (state.streamId !== null) {
      this.manager.cancel(state.streamId, BACKPRESSURE_REASON);
    }
    this.sendEvent(state, {
      type: 'asr.error',
      asrStreamId: streamId,
      code: 'ASR_BACKPRESSURE',
      retryable: true,
      safeMessage: 'ASR_BACKPRESSURE',
    });
    this.sendEvent(state, {
      type: 'asr.closed',
      asrStreamId: streamId,
      reason: 'backpressure',
    });
    this.closeSocket(state, 'backpressure');
  }

  private scheduleFlush(state: ConnectionState): void {
    if (state.flushScheduled) return;
    state.flushScheduled = true;
    queueMicrotask(() => {
      state.flushScheduled = false;
      const events = state.queue;
      state.queue = [];
      for (const event of events) this.sendEvent(state, event);
      if (state.closeAfterFlush) this.closeSocket(state, 'closed');
    });
  }

  private sendEvent(state: ConnectionState, event: AsrClientEvent): void {
    if (state.socketClosed) return;
    try {
      state.socket.send(JSON.stringify(event));
    } catch {
      state.socketClosed = true;
    }
  }

  private failConnection(
    state: ConnectionState,
    code: AsrErrorCode,
    retryable: boolean,
  ): void {
    if (state.terminal) return;
    const streamId = state.streamId ?? 'asr_unassigned';
    state.terminal = true;
    state.queue = [];
    this.sendEvent(state, {
      type: 'asr.error',
      asrStreamId: streamId,
      code,
      retryable,
      safeMessage: code,
    });
    this.sendEvent(state, {
      type: 'asr.closed',
      asrStreamId: streamId,
      reason: 'error',
    });
    this.closeSocket(state, code);
  }

  private finishConnection(state: ConnectionState, reason: string): void {
    if (state.terminal) return;
    if (state.queue.some((event) => event.type === 'asr.closed')) return;
    state.terminal = true;
    this.closeSocket(state, reason);
  }

  private closeSocket(state: ConnectionState, reason: string): void {
    if (state.socketClosed) return;
    state.socketClosed = true;
    this.connections.delete(state);
    state.socket.close(1000, reason);
    if (this.current === state) this.current = null;
  }

  private onSocketClosed(state: ConnectionState): void {
    if (state.socketClosed) return;
    state.socketClosed = true;
    this.connections.delete(state);
    if (this.current === state) this.current = null;
    if (state.terminal) return;
    state.terminal = true;
    if (state.streamId !== null && !state.finished) {
      this.manager.cancel(state.streamId, 'socket_closed');
    }
  }

  private allowStart(deviceId: string): boolean {
    const now = this.now();
    const cutoff = now - RATE_WINDOW_MS;
    const recent = (this.startsByDevice.get(deviceId) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length >= MAX_STARTS_PER_MINUTE) {
      this.startsByDevice.set(deviceId, recent);
      return false;
    }
    recent.push(now);
    this.startsByDevice.set(deviceId, recent);
    return true;
  }
}

function toText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  return null;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) {
    const parts = data.filter(
      (entry): entry is Uint8Array => entry instanceof Uint8Array,
    );
    if (parts.length === data.length) return Buffer.concat(parts);
  }
  return null;
}