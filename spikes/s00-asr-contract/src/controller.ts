import { setTimeout as delay } from 'node:timers/promises';

import {
  AsrConfig,
  AsrEvent,
  AsrProvider,
  AsrSnapshot,
  AsrState,
  AsrStreamHandle,
} from './types.js';

const DEFAULT_FINALIZE_TIMEOUT_MS = 5000;

const TERMINAL_STATES: ReadonlySet<AsrState> = new Set([
  'completed',
  'cancelled',
  'error',
]);

/** 可注入的 finalize 超时，便于测试确定性。 */
export interface AsrControllerOptions {
  finalizeTimeoutMs?: number;
}

/** Provider 中立的 ASR 状态机：不生成 prompt，不触碰主协议。 */
export class AsrController {
  private state: AsrState = 'idle';
  private handle: AsrStreamHandle | undefined;
  private draft = '';
  private finalText: string | undefined;
  private lastSequence = 0;
  private error: AsrSnapshot['error'];
  private resolveFinal: (() => void) | undefined;
  private readonly finalizeTimeoutMs: number;

  constructor(
    private readonly provider: AsrProvider,
    private readonly config: AsrConfig,
    private readonly idFactory: () => string = () => crypto.randomUUID(),
    options: AsrControllerOptions = {},
  ) {
    this.finalizeTimeoutMs =
      options.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS;
  }

  /** 开始一条新的音频流；终态下可重新开始。 */
  async start(): Promise<void> {
    if (
      this.state === 'connecting' ||
      this.state === 'recording' ||
      this.state === 'finalizing'
    ) {
      throw new Error(`ASR cannot start from state ${this.state}`);
    }
    const handle: AsrStreamHandle = { streamId: this.idFactory() };
    this.handle = handle;
    this.state = 'connecting';
    this.draft = '';
    this.finalText = undefined;
    this.lastSequence = 0;
    this.error = undefined;
    await this.provider.start(handle, this.config, (event) => {
      this.handleEvent(event);
    });
  }

  /** 写入音频块，只有 recording 状态允许。 */
  async write(audio: Uint8Array): Promise<void> {
    const handle = this.handle;
    if (handle === undefined || this.state !== 'recording') {
      throw new Error(`ASR cannot write from state ${this.state}`);
    }
    await this.provider.write(handle, audio);
  }

  /** 请求 final；超时仍无 final 时显式失败，不生成空文本。 */
  async finalize(): Promise<void> {
    const handle = this.handle;
    if (handle === undefined || this.state !== 'recording') return;

    this.state = 'finalizing';
    const finalArrived = new Promise<void>((resolve) => {
      this.resolveFinal = resolve;
    });

    try {
      await this.provider.finalize(handle);
      if (this.state === 'finalizing') {
        await Promise.race([finalArrived, delay(this.finalizeTimeoutMs)]);
      }
    } finally {
      this.resolveFinal = undefined;
    }

    if (this.state === 'finalizing') {
      this.fail('ASR_NO_FINAL', false, 'No final transcript was produced');
    }
  }

  /** 取消当前流；之后到达的结果全部丢弃。 */
  async cancel(): Promise<void> {
    const handle = this.handle;
    if (handle === undefined || TERMINAL_STATES.has(this.state)) return;
    this.state = 'cancelled';
    this.resolveFinal?.();
    await this.provider.cancel(handle);
  }

  /** 返回不可变的当前快照副本。 */
  snapshot(): AsrSnapshot {
    return {
      state: this.state,
      ...(this.handle === undefined ? {} : { streamId: this.handle.streamId }),
      draft: this.draft,
      ...(this.finalText === undefined ? {} : { finalText: this.finalText }),
      lastSequence: this.lastSequence,
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  private handleEvent(event: AsrEvent): void {
    if (TERMINAL_STATES.has(this.state)) return;
    if (this.handle === undefined || event.streamId !== this.handle.streamId) {
      return;
    }

    switch (event.type) {
      case 'asr.started':
        this.state = 'recording';
        break;
      case 'asr.partial':
        if (!this.acceptSequence(event.sequence)) return;
        this.draft = event.transcript;
        if (this.state === 'connecting') this.state = 'recording';
        break;
      case 'asr.final':
        if (!this.acceptSequence(event.sequence)) return;
        this.finalText = event.transcript;
        this.draft = event.transcript;
        this.state = 'completed';
        this.resolveFinal?.();
        break;
      case 'asr.error':
        this.error = {
          code: event.code,
          retryable: event.retryable,
          safeMessage: event.safeMessage,
        };
        this.state = 'error';
        this.resolveFinal?.();
        break;
      case 'asr.cancelled':
        this.state = 'cancelled';
        this.resolveFinal?.();
        break;
      case 'asr.closed':
        break;
      default:
        break;
    }
  }

  private acceptSequence(sequence: number): boolean {
    if (sequence <= this.lastSequence) return false;
    this.lastSequence = sequence;
    return true;
  }

  private fail(code: string, retryable: boolean, safeMessage: string): void {
    this.error = { code, retryable, safeMessage };
    this.state = 'error';
  }
}