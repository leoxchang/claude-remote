/**
 * S05 ASR 协议：独立 /ws/asr 通道的控制消息与服务端事件。
 *
 * 与主控制协议共享 envelope 风格，但错误只暴露 code/retryable/safeMessage，
 * 绝不回传 Provider 原文、识别全文或请求头。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';

/** ASR 错误码；前 15 个由 Mac 发出，App 本地错误码不在本类型中。 */
export type AsrErrorCode =
  | 'ASR_NOT_CONFIGURED'
  | 'ASR_CONNECTION_FAILED'
  | 'ASR_PROVIDER_UNAUTHENTICATED'
  | 'ASR_PROVIDER_ERROR'
  | 'ASR_BUSY'
  | 'ASR_RATE_LIMITED'
  | 'ASR_BACKPRESSURE'
  | 'ASR_INVALID_AUDIO'
  | 'ASR_STREAM_CONFLICT'
  | 'ASR_RESULT_TOO_LARGE'
  | 'ASR_FINAL_TIMEOUT'
  | 'ASR_EMPTY_RESULT'
  | 'ASR_PROVIDER_ENDED'
  | 'ASR_PROVIDER_OVERLOADED'
  | 'INVALID_MESSAGE';

/** 安全错误：只含稳定 code、重试提示与固定文案。 */
export class AsrError extends Error {
  constructor(
    readonly code: AsrErrorCode,
    readonly retryable: boolean,
    readonly safeMessage: string = code,
  ) {
    super(safeMessage);
    this.name = 'AsrError';
  }
}

/** App→Mac 控制消息的单条上限。 */
export const MAX_ASR_CONTROL_BYTES = 4 * 1024;

/** 固定音频格式。 */
export interface AsrAudioFormat {
  format: 'pcm-s16le';
  sampleRate: 16000;
  channels: 1;
}

/** 开始录音；payload 只允许音频参数。 */
export interface AsrStartMessage {
  protocolVersion: 1;
  messageId: string;
  timestamp: number;
  type: 'asr.start';
  asrStreamId: string;
  payload: { audio: AsrAudioFormat };
}

/** 结束录音并等待 final。 */
export interface AsrFinishMessage {
  protocolVersion: 1;
  messageId: string;
  timestamp: number;
  type: 'asr.finish';
  asrStreamId: string;
  payload: Record<string, never>;
}

/** 立即取消；迟到结果全部丢弃。 */
export interface AsrCancelMessage {
  protocolVersion: 1;
  messageId: string;
  timestamp: number;
  type: 'asr.cancel';
  asrStreamId: string;
  payload: Record<string, never>;
}

/** 控制消息联合类型。 */
export type AsrControlMessage =
  | AsrStartMessage
  | AsrFinishMessage
  | AsrCancelMessage;

/** Provider 中立事件；由 Provider 适配层产生。 */
export type AsrProviderEvent =
  | { type: 'partial'; text: string }
  | { type: 'utteranceDefinite'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: AsrErrorCode; retryable: boolean }
  | { type: 'closed'; reason: string };

/** Mac→App 事件；只存在于独立音频通道。 */
export type AsrClientEvent =
  | { type: 'asr.started'; asrStreamId: string }
  | {
      type: 'asr.partial';
      asrStreamId: string;
      sequence: number;
      text: string;
    }
  | {
      type: 'asr.final';
      asrStreamId: string;
      sequence: number;
      text: string;
    }
  | {
      type: 'asr.error';
      asrStreamId: string;
      code: AsrErrorCode;
      retryable: boolean;
      safeMessage: string;
    }
  | { type: 'asr.cancelled'; asrStreamId: string; reason: string }
  | { type: 'asr.closed'; asrStreamId: string; reason: string };

const SCHEMA_ID = 'https://s05.local/asr-messages.schema.json';

const CONTROL_REFS = ['asr.start', 'asr.finish', 'asr.cancel'] as const;
const EVENT_REFS = [
  'asr.started',
  'asr.partial',
  'asr.final',
  'asr.error',
  'asr.cancelled',
  'asr.closed',
] as const;

const ajv = new Ajv2020({ allErrors: true, strict: true, verbose: false });
ajv.addSchema(readSchema());

const validateControl = ajv.compile({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: CONTROL_REFS.map((name) => ({ $ref: `${SCHEMA_ID}#/$defs/${name}` })),
});

const validateEvent = ajv.compile({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: EVENT_REFS.map((name) => ({ $ref: `${SCHEMA_ID}#/$defs/${name}` })),
});

/** 校验一条 App→Mac 控制消息；失败抛 INVALID_MESSAGE 且不回显输入。 */
export function validateAsrControlMessage(value: unknown): AsrControlMessage {
  if (utf8Size(value) > MAX_ASR_CONTROL_BYTES) {
    throw invalidMessage();
  }
  if (!validateControl(value)) {
    throw invalidMessage();
  }
  return value as AsrControlMessage;
}

/** 校验一条 Mac→App 事件；失败抛 INVALID_MESSAGE。 */
export function validateAsrServerEvent(value: unknown): AsrClientEvent {
  if (!validateEvent(value)) {
    throw invalidMessage();
  }
  return value as AsrClientEvent;
}

function invalidMessage(): AsrError {
  return new AsrError('INVALID_MESSAGE', false, 'INVALID_MESSAGE');
}

/** JSON 序列化后的 UTF-8 字节数；无法序列化时按超限处理。 */
function utf8Size(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function readSchema(): object {
  const path = fileURLToPath(
    new URL(
      '../../../../protocol/v1/asr-messages.schema.json',
      import.meta.url,
    ),
  );
  return JSON.parse(readFileSync(path, 'utf8')) as object;
}