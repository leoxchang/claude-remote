/**
 * 豆包 bigmodel_async 二进制 framing。
 *
 * 只实现 ASR-00 已证实/官方文档明确的字段；未证实的 cancel 帧或模型参数
 * 不在此实现。所有解析失败都映射为安全 ASR 错误。
 */
import { gunzipSync } from 'node:zlib';

import { AsrError } from '../asr-protocol.js';

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE_WORDS = 0b0001;
const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0b0001;
const MESSAGE_TYPE_AUDIO_ONLY = 0b0010;
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0b1001;
const MESSAGE_TYPE_SERVER_ERROR = 0b1111;
const MESSAGE_TYPE_SERVER_ACK = 0b1011;
const FLAG_POSITIVE_SEQUENCE = 0b0001;
const FLAG_LAST_AUDIO = 0b0010;
const SERIALIZATION_JSON = 0b0001;
const SERIALIZATION_RAW = 0b0000;
const COMPRESSION_NONE = 0b0000;
const COMPRESSION_GZIP = 0b0001;

const HEADER_BYTES = 4;
const SEQUENCE_BYTES = 4;
const PAYLOAD_SIZE_BYTES = 4;

/** 单个服务端帧上限；超过即视为协议错误。 */
export const MAX_SERVER_FRAME_BYTES = 512 * 1024;

/** 解码后的服务端帧；text 只用于内存归一化。 */
export interface DoubaoServerMessage {
  messageType: number;
  flags: number;
  sequence: number | null;
  text: string;
  utteranceDefinite: boolean;
  isLastPackage: boolean;
  errorCode: number | null;
}

/** 编码 JSON 帧（完整客户端请求）。 */
export function encodeJsonFrame(input: {
  sequence: number;
  json: unknown;
}): Uint8Array {
  return encodeFrame({
    messageType: MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    flags: FLAG_POSITIVE_SEQUENCE,
    serialization: SERIALIZATION_JSON,
    sequence: input.sequence,
    payload: Buffer.from(JSON.stringify(input.json), 'utf8'),
  });
}

/** 编码音频帧；`final` 为 true 时携带 last-audio 标志。 */
export function encodeAudioFrame(input: {
  sequence: number;
  audio: Uint8Array;
  final: boolean;
}): Uint8Array {
  return encodeFrame({
    messageType: MESSAGE_TYPE_AUDIO_ONLY,
    flags: input.final
      ? FLAG_POSITIVE_SEQUENCE | FLAG_LAST_AUDIO
      : FLAG_POSITIVE_SEQUENCE,
    serialization: SERIALIZATION_RAW,
    sequence: input.sequence,
    payload: Buffer.from(input.audio),
  });
}

/** 解码服务端帧；截断、超限、未知类型与非 JSON 均抛 ASR_PROVIDER_ERROR。 */
export function decodeServerFrame(frame: Uint8Array): DoubaoServerMessage {
  if (frame.length < HEADER_BYTES) {
    throw protocolError();
  }
  if (frame.length > MAX_SERVER_FRAME_BYTES) {
    throw protocolError();
  }
  const version = (frame[0] ?? 0) >> 4;
  const headerWords = (frame[0] ?? 0) & 0b1111;
  const headerBytes = headerWords * 4;
  if (version !== PROTOCOL_VERSION || headerBytes < HEADER_BYTES) {
    throw protocolError();
  }
  if (frame.length < headerBytes) {
    throw protocolError();
  }
  const second = frame[1] ?? 0;
  const messageType = (second >> 4) & 0b1111;
  const flags = second & 0b1111;
  if (
    messageType !== MESSAGE_TYPE_FULL_SERVER_RESPONSE &&
    messageType !== MESSAGE_TYPE_SERVER_ERROR &&
    messageType !== MESSAGE_TYPE_SERVER_ACK
  ) {
    throw protocolError();
  }
  const compression = (frame[2] ?? 0) & 0b1111;
  let offset = headerBytes;
  let sequence: number | null = null;
  if ((flags & FLAG_POSITIVE_SEQUENCE) !== 0) {
    offset = requireBytes(frame, offset, SEQUENCE_BYTES);
    sequence = new DataView(
      frame.buffer,
      frame.byteOffset + offset - SEQUENCE_BYTES,
      SEQUENCE_BYTES,
    ).getInt32(0, false);
  }
  offset = requireBytes(frame, offset, PAYLOAD_SIZE_BYTES);
  const payloadSize = new DataView(
    frame.buffer,
    frame.byteOffset + offset - PAYLOAD_SIZE_BYTES,
    PAYLOAD_SIZE_BYTES,
  ).getUint32(0, false);
  offset = requireBytes(frame, offset, payloadSize);
  const rawPayload = Buffer.from(frame.subarray(offset - payloadSize, offset));
  const payload = decodePayload(rawPayload, compression);
  return parsePayload(messageType, flags, sequence, payload);
}

function decodePayload(payload: Buffer, compression: number): Buffer {
  if (compression === COMPRESSION_NONE) return payload;
  if (compression !== COMPRESSION_GZIP) throw protocolError();
  try {
    return gunzipSync(payload);
  } catch {
    throw protocolError();
  }
}

function parsePayload(
  messageType: number,
  flags: number,
  sequence: number | null,
  payload: Buffer,
): DoubaoServerMessage {
  const empty: DoubaoServerMessage = {
    messageType,
    flags,
    sequence,
    text: '',
    utteranceDefinite: false,
    isLastPackage: false,
    errorCode: null,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const record = parsed as Record<string, unknown>;
  const code = record['code'];
  const message: DoubaoServerMessage = {
    ...empty,
    errorCode: typeof code === 'number' ? code : null,
  };
  const result = record['result'];
  if (typeof result !== 'object' || result === null) return message;
  const resultRecord = result as Record<string, unknown>;
  const text = resultRecord['text'];
  const utterances = resultRecord['utterances'];
  return {
    ...message,
    text: typeof text === 'string' ? text : '',
    utteranceDefinite: hasUtteranceFlag(utterances, 'definite'),
    isLastPackage: hasUtteranceFlag(utterances, 'is_last_package'),
  };
}

function hasUtteranceFlag(value: unknown, flag: string): boolean {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    if ((entry as Record<string, unknown>)[flag] === true) return true;
  }
  return false;
}

function requireBytes(
  frame: Uint8Array,
  offset: number,
  length: number,
): number {
  const next = offset + length;
  if (next > frame.length) throw protocolError();
  return next;
}

function encodeFrame(input: {
  messageType: number;
  flags: number;
  serialization: number;
  sequence: number;
  payload: Buffer;
}): Uint8Array {
  const body = Buffer.alloc(
    SEQUENCE_BYTES + PAYLOAD_SIZE_BYTES + input.payload.length,
  );
  body.writeInt32BE(input.sequence, 0);
  body.writeUint32BE(input.payload.length, SEQUENCE_BYTES);
  input.payload.copy(body, SEQUENCE_BYTES + PAYLOAD_SIZE_BYTES);
  const header = Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE_WORDS,
    (input.messageType << 4) | input.flags,
    (input.serialization << 4) | COMPRESSION_NONE,
    0,
  ]);
  return Buffer.concat([header, body]);
}

function protocolError(): AsrError {
  return new AsrError('ASR_PROVIDER_ERROR', false, 'ASR_PROVIDER_ERROR');
}