import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AsrError,
  MAX_ASR_CONTROL_BYTES,
  validateAsrControlMessage,
  validateAsrServerEvent,
} from '../../src/asr/asr-protocol.js';

const EXAMPLES_DIR = fileURLToPath(
  new URL('../../../../protocol/v1/examples/s05/', import.meta.url),
);

const CONTROL_TYPES = ['asr.start', 'asr.finish', 'asr.cancel'] as const;
const EVENT_TYPES = [
  'asr.started',
  'asr.partial',
  'asr.final',
  'asr.error',
  'asr.cancelled',
  'asr.closed',
] as const;

interface Example {
  name: string;
  value: Record<string, unknown>;
}

function loadExamples(): Example[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      name,
      value: JSON.parse(
        readFileSync(`${EXAMPLES_DIR}${name}`, 'utf8'),
      ) as Record<string, unknown>,
    }));
}

function validStart(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    messageId: 'msg_test',
    timestamp: 1762432800000,
    type: 'asr.start',
    asrStreamId: 'asr_test',
    payload: {
      audio: { format: 'pcm-s16le', sampleRate: 16000, channels: 1 },
    },
  };
}

function without(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [entryKey, value] of Object.entries(source)) {
    if (entryKey !== key) copy[entryKey] = value;
  }
  return copy;
}

function expectInvalid(value: unknown): AsrError {
  let captured: unknown;
  try {
    validateAsrControlMessage(value);
  } catch (error: unknown) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(AsrError);
  const asrError = captured as AsrError;
  expect(asrError.code).toBe('INVALID_MESSAGE');
  expect(asrError.retryable).toBe(false);
  return asrError;
}

describe('S05 shared ASR protocol', () => {
  it('accepts every control example and every server event example', () => {
    const examples = loadExamples();
    const seen = new Set<string>();
    for (const example of examples) {
      const type = example.value['type'];
      if (typeof type !== 'string') continue;
      seen.add(type);
      if (CONTROL_TYPES.some((entry) => entry === type)) {
        const message = validateAsrControlMessage(example.value);
        expect(message.type, example.name).toBe(type);
      } else {
        const event = validateAsrServerEvent(example.value);
        expect(event.type, example.name).toBe(type);
      }
    }
    expect([...seen].sort()).toEqual([...CONTROL_TYPES, ...EVENT_TYPES].sort());
  });

  it('rejects missing envelope and stream identity', () => {
    for (const key of ['protocolVersion', 'messageId', 'asrStreamId']) {
      const error = expectInvalid(without(validStart(), key));
      expect(error.safeMessage).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects extra session and command fields on the wire', () => {
    for (const key of ['sessionId', 'runId', 'commandId']) {
      expectInvalid({ ...validStart(), [key]: 'forbidden' });
    }
  });

  it('rejects provider configuration inside the payload', () => {
    const base = validStart();
    const payload = base['payload'] as Record<string, unknown>;
    for (const key of ['endpoint', 'apiKey', 'resourceId', 'sessionId']) {
      expectInvalid({
        ...base,
        payload: { ...payload, [key]: 'forbidden' },
      });
    }
  });

  it('rejects a non-PCM audio format or wrong rate', () => {
    const base = validStart();
    const payload = base['payload'] as { audio: Record<string, unknown> };
    expectInvalid({
      ...base,
      payload: { audio: { ...payload.audio, format: 'pcm-s16' } },
    });
    expectInvalid({
      ...base,
      payload: { audio: { ...payload.audio, sampleRate: 8000 } },
    });
    expectInvalid({
      ...base,
      payload: { audio: { ...payload.audio, channels: 2 } },
    });
  });

  it('rejects unknown message types', () => {
    expectInvalid({ ...validStart(), type: 'asr.unknown' });
  });

  it('rejects control messages over 4 KiB without echoing the value', () => {
    const marker = 'S05_SECRET_MARKER';
    const oversized = {
      ...validStart(),
      messageId: `${marker}${'x'.repeat(MAX_ASR_CONTROL_BYTES)}`,
    };
    const error = expectInvalid(oversized);
    expect(error.message).not.toContain(marker);
    expect(error.safeMessage).not.toContain(marker);
  });

  it('rejects invalid sequences and unknown event types', () => {
    const partial = {
      type: 'asr.partial',
      asrStreamId: 'asr_test',
      sequence: 1,
      text: '文本',
    };
    for (const sequence of [0, -1, 1.5, '1']) {
      expect(() =>
        validateAsrServerEvent({ ...partial, sequence }),
      ).toThrow(AsrError);
    }
    expect(() =>
      validateAsrServerEvent({ ...partial, type: 'asr.delta' }),
    ).toThrow(AsrError);
  });
});