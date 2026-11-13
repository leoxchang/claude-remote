/**
 * 单活跃 ASR 流管理：连接超时、final 超时、最长录音与幂等清理。
 *
 * 不缓存音频、不写临时文件；所有终止路径都经同一 cleanup。
 */
import {
  AsrClientEvent,
  AsrError,
  AsrErrorCode,
  AsrProvider,
  AsrProviderHandle,
} from './asr-protocol.js';
import { AsrEventNormalizer } from './asr-event-normalizer.js';

/** 固定默认限制。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_FINAL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RECORDING_MS = 60_000;

/** 固定音频参数。 */
const AUDIO_FORMAT = {
  format: 'pcm-s16le',
  sampleRate: 16000,
  channels: 1,
} as const;

/** 管理器构造参数。 */
export interface AsrStreamManagerInput {
  provider: AsrProvider;
  onEvent: (event: AsrClientEvent) => void;
  connectTimeoutMs?: number;
  finalTimeoutMs?: number;
  maxRecordingMs?: number;
}

interface ActiveStream {
  asrStreamId: string;
  deviceId: string;
  handle: AsrProviderHandle | null;
  normalizer: AsrEventNormalizer;
  finished: boolean;
  terminal: boolean;
  finalTimer: ReturnType<typeof setTimeout> | null;
  recordingTimer: ReturnType<typeof setTimeout> | null;
}

/** 全局最多一个活跃流；新 start 不隐式取消旧流。 */
export class AsrStreamManager {
  private readonly provider: AsrProvider;
  private readonly onEvent: (event: AsrClientEvent) => void;
  private readonly connectTimeoutMs: number;
  private readonly finalTimeoutMs: number;
  private readonly maxRecordingMs: number;
  private active: ActiveStream | null = null;

  constructor(input: AsrStreamManagerInput) {
    this.provider = input.provider;
    this.onEvent = input.onEvent;
    this.connectTimeoutMs =
      input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.finalTimeoutMs = input.finalTimeoutMs ?? DEFAULT_FINAL_TIMEOUT_MS;
    this.maxRecordingMs = input.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS;
  }

  get activeStreamId(): string | null {
    return this.active?.asrStreamId ?? null;
  }

  async start(input: {
    deviceId: string;
    asrStreamId: string;
  }): Promise<void> {
    if (this.active !== null) {
      throw new AsrError('ASR_BUSY', false, 'ASR_BUSY');
    }
    const state: ActiveStream = {
      asrStreamId: input.asrStreamId,
      deviceId: input.deviceId,
      handle: null,
      normalizer: new AsrEventNormalizer({ asrStreamId: input.asrStreamId }),
      finished: false,
      terminal: false,
      finalTimer: null,
      recordingTimer: null,
    };
    this.active = state;
    let handle: AsrProviderHandle;
    try {
      handle = await withTimeout(
        this.provider.start({
          asrStreamId: input.asrStreamId,
          audio: AUDIO_FORMAT,
        }),
        this.connectTimeoutMs,
      );
    } catch (error: unknown) {
      const asrError = toAsrError(error, 'ASR_CONNECTION_FAILED');
      this.failStream(state, asrError.code, asrError.retryable);
      throw asrError;
    }
    if (state.terminal) {
      this.provider.cancel(handle, 'cancelled');
      return;
    }
    state.handle = handle;
    this.emit({ type: 'asr.started', asrStreamId: input.asrStreamId });
    state.recordingTimer = setTimeout(() => {
      this.finish(input.asrStreamId);
    }, this.maxRecordingMs);
    void this.consume(state);
  }

  write(asrStreamId: string, audio: Uint8Array): void {
    const state = this.active;
    if (
      state === null ||
      state.asrStreamId !== asrStreamId ||
      state.terminal ||
      state.finished ||
      state.handle === null
    ) {
      return;
    }
    try {
      this.provider.write(state.handle, audio);
    } catch (error: unknown) {
      const asrError = toAsrError(error, 'ASR_PROVIDER_ERROR');
      this.failStream(state, asrError.code, asrError.retryable);
    }
  }

  finish(asrStreamId: string): void {
    const state = this.active;
    if (
      state === null ||
      state.asrStreamId !== asrStreamId ||
      state.terminal ||
      state.finished
    ) {
      return;
    }
    if (state.handle === null) {
      this.cancel(asrStreamId, 'user');
      return;
    }
    state.finished = true;
    state.normalizer.markFinalizing();
    this.clearRecordingTimer(state);
    try {
      this.provider.finalize(state.handle);
    } catch (error: unknown) {
      const asrError = toAsrError(error, 'ASR_PROVIDER_ERROR');
      this.failStream(state, asrError.code, asrError.retryable);
      return;
    }
    state.finalTimer = setTimeout(() => {
      this.failStream(state, 'ASR_FINAL_TIMEOUT', true);
    }, this.finalTimeoutMs);
  }

  cancel(asrStreamId: string, reason: string): void {
    const state = this.active;
    if (
      state === null ||
      state.asrStreamId !== asrStreamId ||
      state.terminal
    ) {
      return;
    }
    state.finished = true;
    this.emitAll(state.normalizer.cancel(reason));
    this.cleanup(state, reason);
  }

  cancelAll(reason: string): void {
    if (this.active === null) return;
    this.cancel(this.active.asrStreamId, reason);
  }

  private async consume(state: ActiveStream): Promise<void> {
    const handle = state.handle;
    if (handle === null) return;
    try {
      for await (const event of handle.events) {
        if (state.terminal) return;
        if (event.type === 'closed') {
          this.emitAll(state.normalizer.close('socket_closed'));
          this.cleanup(state, 'socket_closed');
          return;
        }
        const normalized = state.normalizer.accept(event);
        if (normalized !== null) this.emit(normalized);
        if (!state.normalizer.isTerminal) continue;
        const reason = normalized?.type === 'asr.error' ? 'error' : 'completed';
        this.emitAll(state.normalizer.close(reason));
        this.cleanup(state, reason);
        return;
      }
    } catch {
      this.failStream(state, 'ASR_PROVIDER_ERROR', true);
    }
  }

  private failStream(
    state: ActiveStream,
    code: AsrErrorCode,
    retryable: boolean,
  ): void {
    if (state.terminal) return;
    this.emitAll(state.normalizer.fail(code, retryable));
    this.cleanup(state, code);
  }

  private cleanup(state: ActiveStream, reason: string): void {
    if (state.terminal) return;
    state.terminal = true;
    this.clearRecordingTimer(state);
    if (state.finalTimer !== null) {
      clearTimeout(state.finalTimer);
      state.finalTimer = null;
    }
    if (this.active === state) this.active = null;
    if (state.handle !== null) {
      this.provider.cancel(state.handle, reason);
    }
  }

  private clearRecordingTimer(state: ActiveStream): void {
    if (state.recordingTimer !== null) {
      clearTimeout(state.recordingTimer);
      state.recordingTimer = null;
    }
  }

  private emit(event: AsrClientEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // 发送失败由连接层关闭；不改变管理器状态。
    }
  }

  private emitAll(events: AsrClientEvent[]): void {
    for (const event of events) this.emit(event);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AsrError('ASR_CONNECTION_FAILED', true, 'ASR_CONNECTION_FAILED'),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function toAsrError(error: unknown, fallback: AsrErrorCode): AsrError {
  if (error instanceof AsrError) return error;
  return new AsrError(fallback, false, fallback);
}