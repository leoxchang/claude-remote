/**
 * ASR-00 真实豆包门禁测试；只有 `ASR00_LIVE=1` 且注入 Key 时执行。
 *
 * 无凭证时整组失败而不是跳过，避免把 BLOCKED 误记为 PASS。
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  ASR00_ENDPOINT,
  Asr00Config,
  audioFingerprint,
  collectFrames,
  decodeServerFrame,
  encodeAudioFrame,
  fixturePath,
  openAsr00Socket,
  probeRecognition,
  readAsr00Config,
  SanitizedFrame,
  writeSanitizedObservation,
} from './s05-asr00-probe.js';

const EVIDENCE_PATH =
  'apps/agent/test/fixtures/s05/doubao/asr00-observations.json';
const SOCKET_WAIT_MS = 2_000;

interface FailureOutcome {
  opened: boolean;
  frames: SanitizedFrame[];
}

function config(): Asr00Config {
  return readAsr00Config(process.env);
}

async function loadPcm(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(fixturePath(name)));
}

/** 直接尝试握手，用于无效凭证与错误 resourceId。 */
async function attemptHandshake(input: Asr00Config): Promise<FailureOutcome> {
  const socket = new WebSocket(ASR00_ENDPOINT, {
    headers: {
      'X-Api-Key': input.apiKey,
      'X-Api-Resource-Id': input.resourceId,
      'X-Api-Request-Id': `asr00-probe-${Date.now()}`,
    },
  });
  socket.on('error', () => {
    // 握手失败由下面的 opened 结果表达。
  });
  const opened = await new Promise<boolean>((resolve) => {
    socket.once('open', () => resolve(true));
    socket.once('error', () => resolve(false));
    socket.once('unexpected-response', () => resolve(false));
  });
  if (!opened) return { opened: false, frames: [] };
  const frames = await collectFrames(socket, SOCKET_WAIT_MS);
  socket.close();
  return { opened: true, frames };
}

describe('ASR-00 real Doubao probe', () => {
  it('accepts the fixed endpoint with X-Api-Key headers', async () => {
    const socket = await openAsr00Socket(config());
    const frames = await collectFrames(socket, SOCKET_WAIT_MS);
    socket.close();
    const errors = frames.filter((frame) => frame.messageType === 0b1111);
    expect(errors).toEqual([]);
  });

  it('recognizes a synthesized Chinese sentence', async () => {
    const pcm = await loadPcm('single-zh.pcm');
    const observation = await probeRecognition({
      config: config(),
      pcm,
      caseName: `single-zh#${audioFingerprint(pcm)}`,
    });
    expect(observation.partialCount).toBeGreaterThan(0);
    expect(observation.finalCount).toBe(1);
    expect(observation.finalTextLength).toBeGreaterThan(0);
    await writeSanitizedObservation(EVIDENCE_PATH, [observation]);
  });

  it('records partial snapshot semantics for multiple sentences', async () => {
    const pcm = await loadPcm('multi-zh.pcm');
    const observation = await probeRecognition({
      config: config(),
      pcm,
      caseName: `multi-zh#${audioFingerprint(pcm)}`,
    });
    expect(observation.finalCount).toBeLessThanOrEqual(1);
    expect(['full', 'delta', 'unknown']).toContain(observation.snapshotMode);
    await writeSanitizedObservation(EVIDENCE_PATH, [observation]);
  });

  it('rejects an invalid API key without producing a final', async () => {
    const outcome = await attemptHandshake({
      apiKey: 'invalid-asr00-key',
      resourceId: 'volc.seedasr.sauc.duration',
    });
    const finals = outcome.frames.filter((frame) => frame.isLastPackage);
    expect(finals).toEqual([]);
    const errors = outcome.frames.filter(
      (frame) => frame.messageType === 0b1111,
    );
    expect(outcome.opened === false || errors.length > 0).toBe(true);
  });

  it('rejects an empty audio stream without a final', async () => {
    const socket = await openAsr00Socket(config());
    socket.send(encodeAudioFrame({ sequence: 2, audio: new Uint8Array(), final: true }));
    const frames = await collectFrames(socket, 10_000);
    socket.close();
    const finals = frames.filter((frame) => frame.isLastPackage);
    expect(finals).toEqual([]);
  });

  it('does not deliver a final after cancel', async () => {
    const socket = await openAsr00Socket(config());
    const pcm = await loadPcm('single-zh.pcm');
    const collected = collectFrames(socket, 2_000);
    socket.send(
      encodeAudioFrame({
        sequence: 2,
        audio: pcm.subarray(0, 6400),
        final: false,
      }),
    );
    socket.close();
    const frames = await collected;
    expect(frames.filter((frame) => frame.isLastPackage)).toEqual([]);
  });

  it('decodes a truncated frame as an invalid input error', () => {
    expect(() => decodeServerFrame(new Uint8Array([0x11, 0x90]))).toThrow(
      'ASR00_INVALID_FRAME',
    );
  });
});