/**
 * ASR 事件归一化：唯一 final、单调 sequence 与安全错误文案。
 *
 * partial.text 是当前识别快照而非 delta；utterance definite 不等于 final；
 * 任何 Provider 原文都不会进入产物事件。
 */
import {
  AsrClientEvent,
  AsrErrorCode,
  AsrProviderEvent,
} from './asr-protocol.js';

/** final 的最大 UTF-8 字节数。 */
export const DEFAULT_MAX_FINAL_BYTES = 16_384;

/** 归一化器构造参数。 */
export interface AsrEventNormalizerInput {
  asrStreamId: string;
  maxFinalBytes?: number;
}

/** 每流一个归一化器；terminal 后所有输入被丢弃。 */
export class AsrEventNormalizer {
  private readonly asrStreamId: string;
  private readonly maxFinalBytes: number;
  private sequence = 0;
  private finalizing = false;
  private finalSeen = false;
  private terminal = false;
  private closed = false;

  constructor(input: AsrEventNormalizerInput) {
    this.asrStreamId = input.asrStreamId;
    this.maxFinalBytes = input.maxFinalBytes ?? DEFAULT_MAX_FINAL_BYTES;
  }

  /** 只有 App 已发送 finish 后才接受 final。 */
  markFinalizing(): void {
    if (this.terminal) return;
    this.finalizing = true;
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  /** 归一化一个 Provider 事件；丢弃时返回 null。 */
  accept(event: AsrProviderEvent): AsrClientEvent | null {
    if (this.terminal || this.finalSeen) return null;
    if (event.type === 'partial') {
      this.sequence += 1;
      return {
        type: 'asr.partial',
        asrStreamId: this.asrStreamId,
        sequence: this.sequence,
        text: event.text,
      };
    }
    if (event.type === 'utteranceDefinite') return null;
    if (event.type === 'error') {
      this.terminal = true;
      return this.errorEvent(event.code, event.retryable);
    }
    if (event.type === 'closed') {
      this.terminal = true;
      return null;
    }
    return this.acceptFinal(event.text);
  }

  /** 取消是终态；返回 cancelled + closed。 */
  cancel(reason: string): AsrClientEvent[] {
    if (this.closed) return [];
    this.closed = true;
    this.terminal = true;
    return [
      { type: 'asr.cancelled', asrStreamId: this.asrStreamId, reason },
      { type: 'asr.closed', asrStreamId: this.asrStreamId, reason },
    ];
  }

  /** 失败是终态；返回 error + closed。 */
  fail(code: AsrErrorCode, retryable: boolean): AsrClientEvent[] {
    if (this.closed) return [];
    this.closed = true;
    this.terminal = true;
    return [
      this.errorEvent(code, retryable),
      { type: 'asr.closed', asrStreamId: this.asrStreamId, reason: 'error' },
    ];
  }

  /** 正常关闭；若已发 error 仍补一条 closed。 */
  close(reason: string): AsrClientEvent[] {
    if (this.closed) return [];
    this.closed = true;
    this.terminal = true;
    return [
      { type: 'asr.closed', asrStreamId: this.asrStreamId, reason },
    ];
  }

  private acceptFinal(text: string): AsrClientEvent {
    this.finalSeen = true;
    this.terminal = true;
    if (!this.finalizing) {
      return this.errorEvent('ASR_PROVIDER_ENDED', false);
    }
    if (text.trim().length === 0) {
      return this.errorEvent('ASR_EMPTY_RESULT', false);
    }
    if (Buffer.byteLength(text, 'utf8') > this.maxFinalBytes) {
      return this.errorEvent('ASR_RESULT_TOO_LARGE', false);
    }
    this.sequence += 1;
    return {
      type: 'asr.final',
      asrStreamId: this.asrStreamId,
      sequence: this.sequence,
      text,
    };
  }

  private errorEvent(
    code: AsrErrorCode,
    retryable: boolean,
  ): AsrClientEvent {
    return {
      type: 'asr.error',
      asrStreamId: this.asrStreamId,
      code,
      retryable,
      safeMessage: code,
    };
  }
}