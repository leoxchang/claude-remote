import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { AsrError } from '../../src/asr/asr-protocol.js';
import {
  MAX_SERVER_FRAME_BYTES,
  decodeServerFrame,
  encodeAudioFrame,
  encodeJsonFrame,
} from '../../src/asr/doubao/doubao-frame.js';

const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0b1001;
const MESSAGE_TYPE_SERVER_ERROR = 0b1111;
const MESSAGE_TYPE_SERVER_ACK = 0b1011;
const SEQUENCE_FLAG = 0b0001;
const LAST_AUDIO_FLAG = 0b0010;

interface ServerFrameInput {
  messageType: number;
  flags?: number;
  sequence?: number;
  json: unknown;
  gzip?: boolean;
}

function serverFrame(input: ServerFrameInput): Uint8Array {
  const json = Buffer.from(JSON.stringify(input.json), 'utf8');
  const payload = input.gzip === true ? gzipSync(json) : json;
  const body = Buffer.alloc(8 + payload.length);
  body.writeInt32BE(input.sequence ?? 1, 0);
  body.writeUint32BE(payload.length, 4);
  payload.copy(body, 8);
  const header = Buffer.from([
    0x11,
    (input.messageType << 4) | (input.flags ?? SEQUENCE_FLAG),
    (input.gzip === true ? 0x01 : 0x00),
    0x00,
  ]);
  return Buffer.concat([header, body]);
}

function resultFrame(
  text: string,
  input: { last?: boolean; definite?: boolean } = {},
): Uint8Array {
  const utterances = [
    {
      text,
      definite: input.definite === true,
      is_last_package: input.last === true,
    },
  ];
  return serverFrame({
    messageType: MESSAGE_TYPE_FULL_SERVER_RESPONSE,
    json: { code: 0, result: { text, utterances } },
  });
}

describe('Doubao binary framing', () => {
  it('encodes a JSON start frame with the documented header', () => {
    const frame = encodeJsonFrame({ sequence: 1, json: { hello: 'world' } });
    expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x11, 0x10, 0x00]);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
    expect(view.getInt32(4, false)).toBe(1);
    const size = view.getUint32(8, false);
    expect(size).toBe(frame.length - 12);
    expect(Buffer.from(frame.subarray(12)).toString('utf8')).toBe(
      '{"hello":"world"}',
    );
  });

  it('marks only the last audio frame as last-audio', () => {
    const normal = encodeAudioFrame({
      sequence: 2,
      audio: new Uint8Array([1, 2]),
      final: false,
    });
    const last = encodeAudioFrame({
      sequence: 3,
      audio: new Uint8Array([3, 4]),
      final: true,
    });
    expect(normal[1] ?? 0).toBe((0b0010 << 4) | SEQUENCE_FLAG);
    expect(last[1] ?? 0).toBe((0b0010 << 4) | SEQUENCE_FLAG | LAST_AUDIO_FLAG);
    expect([...last.subarray(8, 12)]).toEqual([0, 0, 0, 2]);
  });

  it('decodes partial, definite and final responses', () => {
    const partial = decodeServerFrame(resultFrame('你好'));
    expect(partial.text).toBe('你好');
    expect(partial.isLastPackage).toBe(false);
    expect(partial.utteranceDefinite).toBe(false);

    const definite = decodeServerFrame(
      resultFrame('你好，', { definite: true }),
    );
    expect(definite.utteranceDefinite).toBe(true);

    const final = decodeServerFrame(resultFrame('你好，世界。', { last: true }));
    expect(final.isLastPackage).toBe(true);
    expect(final.text).toBe('你好，世界。');
  });

  it('decodes acknowledgements and server errors', () => {
    const ack = decodeServerFrame(
      serverFrame({
        messageType: MESSAGE_TYPE_SERVER_ACK,
        json: { code: 0, message: 'OK' },
      }),
    );
    expect(ack.messageType).toBe(MESSAGE_TYPE_SERVER_ACK);
    expect(ack.errorCode).toBe(0);

    const error = decodeServerFrame(
      serverFrame({
        messageType: MESSAGE_TYPE_SERVER_ERROR,
        json: { code: 45000001, message: 'bad request' },
      }),
    );
    expect(error.errorCode).toBe(45000001);
  });

  it('decodes gzip payloads', () => {
    const frame = decodeServerFrame(
      serverFrame({
        messageType: MESSAGE_TYPE_FULL_SERVER_RESPONSE,
        json: { code: 0, result: { text: '压缩', utterances: [] } },
        gzip: true,
      }),
    );
    expect(frame.text).toBe('压缩');
  });

  it('rejects truncated, oversized and unknown frames', () => {
    expect(() => decodeServerFrame(new Uint8Array([0x11, 0x90]))).toThrow(
      AsrError,
    );
    const oversized = new Uint8Array(MAX_SERVER_FRAME_BYTES + 1);
    expect(() => decodeServerFrame(oversized)).toThrow(AsrError);
    const unknown = serverFrame({
      messageType: 0b0111,
      json: { code: 0 },
    });
    expect(() => decodeServerFrame(unknown)).toThrow(AsrError);
  });

  it('never embeds credentials in frames', () => {
    const frames = [
      encodeJsonFrame({ sequence: 1, json: { request: {} } }),
      encodeAudioFrame({ sequence: 2, audio: new Uint8Array([1, 2]), final: true }),
    ];
    for (const frame of frames) {
      const text = Buffer.from(frame).toString('utf8');
      expect(text).not.toContain('X-Api-Key');
      expect(text).not.toContain('Authorization');
    }
  });

  it('rejects bad headers, unsupported compression and corrupt gzip', () => {
    const valid = resultFrame('你好');
    const wrongVersion = Uint8Array.from(valid);
    wrongVersion[0] = 0x21;
    expect(() => decodeServerFrame(wrongVersion)).toThrow(AsrError);
    const zeroHeader = Uint8Array.from(valid);
    zeroHeader[0] = 0x10;
    expect(() => decodeServerFrame(zeroHeader)).toThrow(AsrError);
    for (const compression of [0b0010, 0b0001]) {
      const payload = Buffer.from('{}');
      const body = Buffer.alloc(8 + payload.length);
      body.writeInt32BE(1, 0);
      body.writeUint32BE(payload.length, 4);
      payload.copy(body, 8);
      const frame = Buffer.concat([
        Buffer.from([0x11, 0x91, compression, 0x00]),
        body,
      ]);
      expect(() => decodeServerFrame(frame)).toThrow(AsrError);
    }
  });

  it('returns empty snapshots for non-object or result-less payloads', () => {
    const scalar = decodeServerFrame(
      serverFrame({ messageType: MESSAGE_TYPE_FULL_SERVER_RESPONSE, json: 5 }),
    );
    expect(scalar.text).toBe('');
    const noResult = decodeServerFrame(
      serverFrame({
        messageType: MESSAGE_TYPE_FULL_SERVER_RESPONSE,
        json: { code: 0 },
      }),
    );
    expect(noResult.utteranceDefinite).toBe(false);
    expect(noResult.isLastPackage).toBe(false);
  });
});