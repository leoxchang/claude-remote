/**
 * 唯一豆包 Provider 边界：认证、二进制 framing、生命周期与背压。
 *
 * API Key 只存在于本对象内存；事件与音频不写日志、SQLite 或文件。
 */
import { RawData, WebSocket } from 'ws';

import {
  AsrError,
  AsrProvider,
  AsrProviderEvent,
  AsrProviderHandle,
  AsrProviderStart,
} from '../asr-protocol.js';
import { AsrConfig, DOUBAO_ASR_ENDPOINT } from '../asr-config.js';
import {
  DoubaoServerMessage,
  decodeServerFrame,
  encodeAudioFrame,
  encodeJsonFrame,
} from './doubao-frame.js';

/** 标准音频包 200 ms。 */
const MAX_AUDIO_PACKET_BYTES = 6400;

/** Provider 发送缓冲上限。 */
const MAX_BUFFERED_BYTES = 256 * 1024;

/** 连接超时。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** 无音频时 finalize 仍需一个非空偶数字节包。 */
const SILENT_SAMPLE = new Uint8Array([0, 0]);

/** 550xxxxx 官方偶发错误视为过载。 */
const OVERLOAD_MIN = 55_000_000;
const OVERLOAD_MAX = 56_000_000;

/** 最小 WebSocket 抽象；测试注入 fake。 */
export interface WebSocketLike {
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  readonly bufferedAmount: number;
}

/** socket 工厂；URL 与请求头由 Provider 固定。 */
export type OpenSocket = (
  url: string,
  headers: Record<string, string>,
) => WebSocketLike;

/** Provider 构造参数。 */
export interface DoubaoAsrProviderInput {
  config: AsrConfig;
  openSocket?: OpenSocket;
  requestId?: () => string;
  connectTimeoutMs?: number;
}

interface HandleState {
  asrStreamId: string;
  socket: WebSocketLike;
  ready: boolean;
  finalizeSent: boolean;
  terminal: boolean;
  sequence: number;
  pendingAudio: Uint8Array | null;
  connectTimer: ReturnType<typeof setTimeout> | null;
  connectResolve: (() => void) | null;
  connectReject: ((error: AsrError) => void) | null;
  queue: AsrProviderEvent[];
  waiters: Array<() => void>;
}

/** 豆包 Provider；每次 start 一个独立 socket 与 handle。 */
export class DoubaoAsrProvider implements AsrProvider {
  private readonly config: AsrConfig;
  private readonly openSocket: OpenSocket;
  private readonly requestId: () => string;
  private readonly connectTimeoutMs: number;
  private readonly states = new WeakMap<AsrProviderHandle, HandleState>();

  constructor(input: DoubaoAsrProviderInput) {
    this.config = input.config;
    this.openSocket = input.openSocket ?? openNodeSocket;
    this.requestId =
      input.requestId ?? (() => `asr_${cryptoRequestId()}`);
    this.connectTimeoutMs =
      input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  async start(input: AsrProviderStart): Promise<AsrProviderHandle> {
    const requestId = this.requestId();
    const socket = this.openSocket(DOUBAO_ASR_ENDPOINT, {
      'X-Api-Key': this.config.apiKey,
      'X-Api-Resource-Id': this.config.resourceId,
      'X-Api-Request-Id': requestId,
    });
    const state: HandleState = {
      asrStreamId: input.asrStreamId,
      socket,
      ready: false,
      finalizeSent: false,
      terminal: false,
      sequence: 2,
      pendingAudio: null,
      connectTimer: null,
      connectResolve: null,
      connectReject: null,
      queue: [],
      waiters: [],
    };
    const handle: AsrProviderHandle = {
      asrStreamId: input.asrStreamId,
      events: this.iterate(state),
    };
    this.states.set(handle, state);
    this.attachListeners(state);
    await this.waitForOpen(state);
    state.ready = true;
    socket.send(encodeJsonFrame({ sequence: 1, json: startPayload() }));
    return handle;
  }

  write(handle: AsrProviderHandle, audio: Uint8Array): void {
    const state = this.requireState(handle);
    if (state.terminal) return;
    if (!state.ready) {
      if (state.finalizeSent) return;
      throw new AsrError('ASR_STREAM_CONFLICT', false, 'ASR_STREAM_CONFLICT');
    }
    if (
      audio.length === 0 ||
      audio.length % 2 !== 0 ||
      audio.length > MAX_AUDIO_PACKET_BYTES
    ) {
      this.terminate(state, 'invalid_audio', {
        type: 'error',
        code: 'ASR_INVALID_AUDIO',
        retryable: false,
      });
      return;
    }
    if (state.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.terminate(state, 'backpressure', {
        type: 'error',
        code: 'ASR_BACKPRESSURE',
        retryable: true,
      });
      return;
    }
    if (state.pendingAudio !== null) {
      this.sendAudio(state, state.pendingAudio, false);
    }
    state.pendingAudio = audio;
  }

  finalize(handle: AsrProviderHandle): void {
    const state = this.requireState(handle);
    if (state.terminal || state.finalizeSent || !state.ready) return;
    const audio = state.pendingAudio ?? SILENT_SAMPLE;
    state.pendingAudio = null;
    state.finalizeSent = true;
    state.ready = false;
    this.sendAudio(state, audio, true);
  }

  cancel(handle: AsrProviderHandle, reason: string): void {
    const state = this.states.get(handle);
    if (state === undefined || state.terminal) return;
    state.terminal = true;
    state.ready = false;
    state.pendingAudio = null;
    state.queue = [];
    if (state.connectTimer !== null) clearTimeout(state.connectTimer);
    state.connectTimer = null;
    this.wake(state);
    state.socket.close(1000, reason);
  }

  private attachListeners(state: HandleState): void {
    state.socket.on('open', () => {
      if (state.connectResolve !== null) {
        const resolve = state.connectResolve;
        state.connectResolve = null;
        state.connectReject = null;
        if (state.connectTimer !== null) clearTimeout(state.connectTimer);
        state.connectTimer = null;
        resolve();
      }
    });
    state.socket.on('message', (data: unknown) => {
      this.onMessage(state, data);
    });
    state.socket.on('error', (error: unknown) => {
      if (state.connectReject !== null) {
        const reject = state.connectReject;
        state.connectResolve = null;
        state.connectReject = null;
        if (state.connectTimer !== null) clearTimeout(state.connectTimer);
        state.connectTimer = null;
        reject(handshakeError(error));
        return;
      }
      this.terminate(state, 'socket_error', {
        type: 'error',
        code: 'ASR_CONNECTION_FAILED',
        retryable: true,
      });
    });
    state.socket.on('close', () => {
      if (state.connectReject !== null) {
        const reject = state.connectReject;
        state.connectResolve = null;
        state.connectReject = null;
        if (state.connectTimer !== null) clearTimeout(state.connectTimer);
        state.connectTimer = null;
        reject(
          new AsrError(
            'ASR_CONNECTION_FAILED',
            true,
            'ASR_CONNECTION_FAILED',
          ),
        );
        return;
      }
      if (!state.terminal) {
        this.terminate(state, 'socket_closed', {
          type: 'closed',
          reason: 'socket_closed',
        });
      }
    });
  }

  private waitForOpen(state: HandleState): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      state.connectResolve = resolve;
      state.connectReject = reject;
      state.connectTimer = setTimeout(() => {
        state.connectResolve = null;
        state.connectReject = null;
        state.connectTimer = null;
        reject(
          new AsrError('ASR_CONNECTION_FAILED', true, 'ASR_CONNECTION_FAILED'),
        );
        state.socket.close(1000, 'connect_timeout');
      }, this.connectTimeoutMs);
    });
  }

  private onMessage(state: HandleState, data: unknown): void {
    if (state.terminal || (!state.ready && !state.finalizeSent)) return;
    const frame = toBytes(data);
    if (frame === null) {
      this.terminate(state, 'provider_error', {
        type: 'error',
        code: 'ASR_PROVIDER_ERROR',
        retryable: true,
      });
      return;
    }
    let message: DoubaoServerMessage;
    try {
      message = decodeServerFrame(frame);
    } catch {
      this.terminate(state, 'provider_error', {
        type: 'error',
        code: 'ASR_PROVIDER_ERROR',
        retryable: true,
      });
      return;
    }
    if (message.errorCode !== null && message.errorCode !== 0) {
      this.terminate(state, 'provider_error', {
        type: 'error',
        code: overloaded(message.errorCode)
          ? 'ASR_PROVIDER_OVERLOADED'
          : 'ASR_PROVIDER_ERROR',
        retryable: true,
      });
      return;
    }
    if (message.isLastPackage) {
      this.push(state, { type: 'final', text: message.text });
      return;
    }
    if (message.utteranceDefinite) {
      this.push(state, {
        type: 'utteranceDefinite',
        text: message.text,
      });
      return;
    }
    if (message.text.length > 0) {
      this.push(state, { type: 'partial', text: message.text });
    }
  }

  private sendAudio(
    state: HandleState,
    audio: Uint8Array,
    final: boolean,
  ): void {
    const frame = encodeAudioFrame({
      sequence: state.sequence,
      audio,
      final,
    });
    state.sequence += 1;
    try {
      state.socket.send(frame);
    } catch {
      this.terminate(state, 'socket_error', {
        type: 'error',
        code: 'ASR_CONNECTION_FAILED',
        retryable: true,
      });
    }
  }

  private terminate(
    state: HandleState,
    reason: string,
    event: AsrProviderEvent,
  ): void {
    if (state.terminal) return;
    state.ready = false;
    state.pendingAudio = null;
    if (state.connectTimer !== null) clearTimeout(state.connectTimer);
    state.connectTimer = null;
    state.terminal = true;
    state.queue.push(event);
    state.queue.push({ type: 'closed', reason });
    this.wake(state);
    state.socket.close(1000, reason);
  }

  private push(state: HandleState, event: AsrProviderEvent): void {
    if (state.terminal) return;
    state.queue.push(event);
    this.wake(state);
  }

  private wake(state: HandleState): void {
    const waiters = state.waiters;
    state.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private async *iterate(
    state: HandleState,
  ): AsyncGenerator<AsrProviderEvent> {
    while (true) {
      const event = state.queue.shift();
      if (event !== undefined) {
        yield event;
        if (event.type === 'closed') return;
        continue;
      }
      if (state.terminal) return;
      await new Promise<void>((resolve) => {
        state.waiters.push(resolve);
      });
    }
  }

  private requireState(handle: AsrProviderHandle): HandleState {
    const state = this.states.get(handle);
    if (state === undefined) {
      throw new AsrError('ASR_STREAM_CONFLICT', false, 'ASR_STREAM_CONFLICT');
    }
    return state;
  }
}

/** 默认工厂；生产代码只在这里创建真实 socket。 */
export function createDoubaoAsrProvider(
  config: AsrConfig,
  openSocket?: OpenSocket,
): DoubaoAsrProvider {
  return new DoubaoAsrProvider({
    config,
    ...(openSocket === undefined ? {} : { openSocket }),
  });
}

function openNodeSocket(
  url: string,
  headers: Record<string, string>,
): WebSocketLike {
  return new NodeSocket(new WebSocket(url, { headers }));
}

/** ws 适配器；把非 101 响应转成带 statusCode 的错误。 */
class NodeSocket implements WebSocketLike {
  private readonly errorListeners: Array<(error: unknown) => void> = [];

  constructor(private readonly socket: WebSocket) {
    this.socket.on('unexpected-response', (_request, response) => {
      this.emitError({ statusCode: response.statusCode });
    });
    this.socket.on('error', (error) => {
      this.emitError(error);
    });
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  send(data: Uint8Array | string): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    if (event === 'error') {
      this.errorListeners.push(listener);
      return;
    }
    if (event === 'open' || event === 'close') {
      this.socket.on(event, listener as () => void);
      return;
    }
    if (event === 'message') {
      this.socket.on('message', listener as (data: RawData) => void);
    }
  }

  private emitError(error: unknown): void {
    for (const listener of this.errorListeners) listener(error);
  }
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

function handshakeError(error: unknown): AsrError {
  if (typeof error === 'object' && error !== null) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number') {
      return new AsrError(
        'ASR_PROVIDER_UNAUTHENTICATED',
        false,
        'ASR_PROVIDER_UNAUTHENTICATED',
      );
    }
  }
  return new AsrError('ASR_CONNECTION_FAILED', true, 'ASR_CONNECTION_FAILED');
}

function overloaded(code: number): boolean {
  return code >= OVERLOAD_MIN && code < OVERLOAD_MAX;
}

function startPayload(): Record<string, unknown> {
  return {
    user: { uid: 'claude-remote' },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: 16000,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: 'bigmodel',
      show_utterances: true,
      result_type: 'full',
    },
  };
}

function cryptoRequestId(): string {
  return globalThis.crypto.randomUUID();
}