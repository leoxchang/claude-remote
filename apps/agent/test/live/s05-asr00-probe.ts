/**
 * ASR-00 真实豆包探针：只做诊断，不是产品代码。
 *
 * 覆盖 spec ASR-00 的鉴权、PCM 识别、partial/final 语义、finish/cancel
 * 与错误映射。所有输出只保留脱敏字段，不记录 API Key、请求头或识别全文。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { WebSocket } from 'ws';
import { gunzipSync } from 'node:zlib';

/** 固定官方 endpoint；不接受 App 或环境覆盖。 */
export const ASR00_ENDPOINT =
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

/** 允许的 resourceId。 */
export type Asr00ResourceId =
  | 'volc.seedasr.sauc.duration'
  | 'volc.seedasr.sauc.concurrent';

/** 探针配置；API Key 只来自进程环境。 */
export interface Asr00Config {
  apiKey: string;
  resourceId: Asr00ResourceId;
}

/** 标准音频包：200 ms / 6,400 bytes。 */
export const ASR00_PACKET_BYTES = 6400;

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE_WORDS = 0b0001;
const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0b0001;
const MESSAGE_TYPE_AUDIO_ONLY = 0b0010;
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0b1001;
const MESSAGE_TYPE_SERVER_ACK = 0b1011;
const MESSAGE_TYPE_SERVER_ERROR = 0b1111;
const FLAG_POSITIVE_SEQUENCE = 0b0001;
const FLAG_LAST_AUDIO = 0b0010;
const SERIALIZATION_JSON = 0b0001;
const SERIALIZATION_RAW = 0b0000;
const COMPRESSION_NONE = 0b0000;
const COMPRESSION_GZIP = 0b0001;
const HEADER_BYTES = 4;
const SEQUENCE_BYTES = 4;
const PAYLOAD_SIZE_BYTES = 4;

/** 服务端帧的脱敏形态。 */
export interface SanitizedFrame {
  messageType: number;
  flags: number;
  code: number | null;
  sequence: number | null;
  textLength: number;
  utteranceCount: number;
  definiteCount: number;
  isLastPackage: boolean;
}

/** 一次探针运行的脱敏结果。 */
export interface ProbeObservation {
  case: string;
  accepted: boolean;
  partialCount: number;
  finalCount: number;
  finalTextLength: number;
  snapshotMode: 'full' | 'delta' | 'unknown';
  finalAfterFinishMs: number | null;
  errorCode: number | null;
  frames: SanitizedFrame[];
}

/** 从环境读取探针配置；缺 Key 时抛错，绝不回显值。 */
export function readAsr00Config(env: NodeJS.ProcessEnv): Asr00Config {
  const apiKey = env['DOUBAO_ASR_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('ASR00_BLOCKED: DOUBAO_ASR_API_KEY is missing');
  }
  const rawResource = env['DOUBAO_ASR_RESOURCE_ID'];
  const resourceId: Asr00ResourceId =
    rawResource === undefined || rawResource.length === 0
      ? 'volc.seedasr.sauc.duration'
      : parseResourceId(rawResource);
  return { apiKey, resourceId };
}

function parseResourceId(value: string): Asr00ResourceId {
  if (
    value === 'volc.seedasr.sauc.duration' ||
    value === 'volc.seedasr.sauc.concurrent'
  ) {
    return value;
  }
  throw new Error('ASR00_BLOCKED: invalid DOUBAO_ASR_RESOURCE_ID');
}

/** 构造完整客户端请求帧（JSON payload）。 */
export function encodeStartFrame(sequence: number): Uint8Array {
  return encodeFrame({
    messageType: MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    flags: FLAG_POSITIVE_SEQUENCE,
    serialization: SERIALIZATION_JSON,
    sequence,
    payload: Buffer.from(JSON.stringify(startPayload()), 'utf8'),
  });
}

/** 构造音频帧；最后一条使用 last-audio 标志。 */
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

/** 服务端帧解析；支持未压缩与 gzip。 */
export function decodeServerFrame(frame: Uint8Array): SanitizedFrame {
  if (frame.length < HEADER_BYTES) {
    throw new Error('ASR00_INVALID_FRAME: truncated header');
  }
  const second = frame[1] ?? 0;
  const third = frame[2] ?? 0;
  const messageType = (second >> 4) & 0b1111;
  const flags = second & 0b1111;
  const compression = third & 0b1111;
  let offset = HEADER_BYTES;
  let sequence: number | null = null;
  if ((flags & FLAG_POSITIVE_SEQUENCE) !== 0) {
    sequence = new DataView(
      frame.buffer,
      frame.byteOffset + offset,
      SEQUENCE_BYTES,
    ).getInt32(0, false);
    offset += SEQUENCE_BYTES;
  }
  if (frame.length < offset + PAYLOAD_SIZE_BYTES) {
    throw new Error('ASR00_INVALID_FRAME: truncated payload size');
  }
  const payloadSize = new DataView(
    frame.buffer,
    frame.byteOffset + offset,
    PAYLOAD_SIZE_BYTES,
  ).getUint32(0, false);
  offset += PAYLOAD_SIZE_BYTES;
  if (frame.length < offset + payloadSize) {
    throw new Error('ASR00_INVALID_FRAME: truncated payload');
  }
  const rawPayload = Buffer.from(frame.subarray(offset, offset + payloadSize));
  const payload =
    compression === COMPRESSION_GZIP
      ? gunzipSync(rawPayload)
      : rawPayload;
  return summarizeFrame(messageType, flags, sequence, payload);
}

function summarizeFrame(
  messageType: number,
  flags: number,
  sequence: number | null,
  payload: Buffer,
): SanitizedFrame {
  const summary: SanitizedFrame = {
    messageType,
    flags,
    code: null,
    sequence,
    textLength: 0,
    utteranceCount: 0,
    definiteCount: 0,
    isLastPackage: false,
  };
  if (
    messageType !== MESSAGE_TYPE_FULL_SERVER_RESPONSE &&
    messageType !== MESSAGE_TYPE_SERVER_ERROR &&
    messageType !== MESSAGE_TYPE_SERVER_ACK
  ) {
    return summary;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    return summary;
  }
  if (typeof parsed !== 'object' || parsed === null) return summary;
  const record = parsed as Record<string, unknown>;
  summary.code = typeof record['code'] === 'number' ? record['code'] : null;
  const result = record['result'];
  if (typeof result !== 'object' || result === null) return summary;
  const resultRecord = result as Record<string, unknown>;
  const text = resultRecord['text'];
  if (typeof text === 'string') summary.textLength = text.length;
  const utterances = resultRecord['utterances'];
  if (Array.isArray(utterances)) {
    summary.utteranceCount = utterances.length;
    summary.definiteCount = utterances.filter((entry) => {
      if (typeof entry !== 'object' || entry === null) return false;
      return (entry as Record<string, unknown>)['definite'] === true;
    }).length;
    summary.isLastPackage = isLastPackage(utterances);
  }
  return summary;
}

function isLastPackage(utterances: unknown[]): boolean {
  for (const entry of utterances) {
    if (typeof entry !== 'object' || entry === null) continue;
    if ((entry as Record<string, unknown>)['is_last_package'] === true) {
      return true;
    }
  }
  return false;
}

/** 连接豆包并发送 start；返回已打开的 socket。 */
export async function openAsr00Socket(
  config: Asr00Config,
  socketFactory: (url: string, headers: Record<string, string>) => WebSocket = (
    url,
    headers,
  ) => new WebSocket(url, { headers }),
): Promise<WebSocket> {
  const requestId = randomUUID();
  const socket = socketFactory(ASR00_ENDPOINT, {
    'X-Api-Key': config.apiKey,
    'X-Api-Resource-Id': config.resourceId,
    'X-Api-Request-Id': requestId,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', (error: Error) => reject(error));
  });
  socket.send(encodeStartFrame(1));
  return socket;
}

/** 收集服务端帧直到超时或连接关闭。 */
export async function collectFrames(
  socket: WebSocket,
  timeoutMs: number,
): Promise<SanitizedFrame[]> {
  const frames: SanitizedFrame[] = [];
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const finish = (): void => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', finish);
      socket.off('error', finish);
      resolve();
    };
    const onMessage = (data: WebSocket.RawData): void => {
      const buffer = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
      try {
        frames.push(decodeServerFrame(buffer));
      } catch {
        frames.push(invalidFrame());
      }
    };
    socket.on('message', onMessage);
    socket.on('close', finish);
    socket.on('error', finish);
  });
  return frames;
}

/**
 * 运行一次完整识别：start → 每 200 ms 一帧 → 最后一包。
 * 返回脱敏观察；识别文本只用于长度与快照判定，不落文件。
 */
export async function probeRecognition(input: {
  config: Asr00Config;
  pcm: Uint8Array;
  caseName: string;
  timeoutMs?: number;
}): Promise<ProbeObservation> {
  const socket = await openAsr00Socket(input.config);
  const frames: SanitizedFrame[] = [];
  const messageListener = (data: WebSocket.RawData): void => {
    const buffer = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer);
    try {
      frames.push(decodeServerFrame(buffer));
    } catch {
      frames.push(invalidFrame());
    }
  };
  socket.on('message', messageListener);
  let sequence = 2;
  for (let offset = 0; offset < input.pcm.length; offset += ASR00_PACKET_BYTES) {
    const end = Math.min(offset + ASR00_PACKET_BYTES, input.pcm.length);
    socket.send(
      encodeAudioFrame({
        sequence,
        audio: input.pcm.subarray(offset, end),
        final: end === input.pcm.length,
      }),
    );
    sequence += 1;
    await delay(200);
  }
  const finishSentAt = Date.now();
  await delay(input.timeoutMs ?? 10_000);
  socket.close();
  socket.off('message', messageListener);
  return summarizeObservation(input.caseName, frames, finishSentAt);
}

/** 汇总脱敏观察；快照语义按 text 是否包含前一快照判定。 */
export function summarizeObservation(
  caseName: string,
  frames: SanitizedFrame[],
  finishSentAt: number | null,
): ProbeObservation {
  const responses = frames.filter(
    (frame) => frame.messageType === MESSAGE_TYPE_FULL_SERVER_RESPONSE,
  );
  const finals = responses.filter((frame) => frame.isLastPackage);
  return {
    case: caseName,
    accepted: finals.length > 0 || responses.length > 0,
    partialCount: responses.length - finals.length,
    finalCount: finals.length,
    finalTextLength: finals[0]?.textLength ?? 0,
    snapshotMode: snapshotMode(responses),
    finalAfterFinishMs:
      finals.length === 0 || finishSentAt === null
        ? null
        : Date.now() - finishSentAt,
    errorCode: firstErrorCode(frames),
    frames,
  };
}

function snapshotMode(
  responses: SanitizedFrame[],
): 'full' | 'delta' | 'unknown' {
  let previous = 0;
  let sawDelta = false;
  for (const frame of responses) {
    if (frame.textLength < previous) sawDelta = true;
    previous = frame.textLength;
  }
  if (responses.length < 2) return 'unknown';
  return sawDelta ? 'delta' : 'full';
}

function firstErrorCode(frames: SanitizedFrame[]): number | null {
  for (const frame of frames) {
    if (frame.messageType === MESSAGE_TYPE_SERVER_ERROR) return frame.code;
  }
  return null;
}

/** 写入脱敏证据 JSON；调用方负责放在夹具目录。 */
export async function writeSanitizedObservation(
  filePath: string,
  observations: ProbeObservation[],
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(observations, null, 2)}\n`,
    'utf8',
  );
}

/** 夹具路径：只返回文件名，不暴露个人路径。 */
export function fixturePath(name: string): string {
  return join('apps/agent/test/fixtures/s05/audio', name);
}

/** 合成音频的脱敏指纹；用于证据中标识输入而不保存正文。 */
export function audioFingerprint(pcm: Uint8Array): string {
  return createHash('sha256').update(pcm).digest('hex').slice(0, 16);
}

function startPayload(): Record<string, unknown> {
  return {
    user: { uid: 's05-asr00-probe' },
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

function invalidFrame(): SanitizedFrame {
  return {
    messageType: 0,
    flags: 0,
    code: null,
    sequence: null,
    textLength: 0,
    utteranceCount: 0,
    definiteCount: 0,
    isLastPackage: false,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}