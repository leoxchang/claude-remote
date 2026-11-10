/** ASR 生命周期状态。 */
export type AsrState =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'error';

/** 豆包配置占位；所有字段仍需在真实联调时按官方文档核对。 */
export interface AsrConfig {
  provider: 'doubao';
  appId: string;
  accessToken: string;
  resourceId: string;
  endpoint: string;
  model?: string;
}

/** 每条音频流的独立句柄，与 commandId 分离。 */
export interface AsrStreamHandle {
  readonly streamId: string;
}

/** Provider 中立事件；全部位于 asr.* 命名空间。 */
export type AsrEvent =
  | { type: 'asr.started'; streamId: string }
  | { type: 'asr.partial'; streamId: string; transcript: string; sequence: number }
  | { type: 'asr.final'; streamId: string; transcript: string; sequence: number }
  | {
      type: 'asr.error';
      streamId: string;
      code: string;
      retryable: boolean;
      safeMessage: string;
    }
  | { type: 'asr.cancelled'; streamId: string }
  | { type: 'asr.closed'; streamId: string };

/** 控制器对外暴露的只读快照。 */
export interface AsrSnapshot {
  state: AsrState;
  streamId?: string;
  draft: string;
  finalText?: string;
  lastSequence: number;
  error?: {
    code: string;
    retryable: boolean;
    safeMessage: string;
  };
}

/** Provider 中立接口：start 返回句柄，finalize 产生 final 或错误。 */
export interface AsrProvider {
  start(
    handle: AsrStreamHandle,
    config: AsrConfig,
    emit: (event: AsrEvent) => void,
  ): Promise<void>;
  write(handle: AsrStreamHandle, audio: Uint8Array): Promise<void>;
  finalize(handle: AsrStreamHandle): Promise<void>;
  cancel(handle: AsrStreamHandle): Promise<void>;
}