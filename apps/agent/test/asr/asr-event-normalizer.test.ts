import { describe, expect, it } from 'vitest';

import {
  AsrClientEvent,
  AsrEventNormalizer,
  DEFAULT_MAX_FINAL_BYTES,
} from '../../src/asr/asr-event-normalizer.js';

function normalizer(maxFinalBytes?: number): AsrEventNormalizer {
  return new AsrEventNormalizer({
    asrStreamId: 'asr_1',
    ...(maxFinalBytes === undefined ? {} : { maxFinalBytes }),
  });
}

function types(events: AsrClientEvent[]): string[] {
  return events.map((event) => event.type);
}

describe('AsrEventNormalizer', () => {
  it('increments partial sequence from 1 and passes snapshots through', () => {
    const subject = normalizer();
    const first = subject.accept({ type: 'partial', text: '你' });
    const second = subject.accept({ type: 'partial', text: '你好' });
    expect(first).toEqual({
      type: 'asr.partial',
      asrStreamId: 'asr_1',
      sequence: 1,
      text: '你',
    });
    expect(second).toEqual({
      type: 'asr.partial',
      asrStreamId: 'asr_1',
      sequence: 2,
      text: '你好',
    });
  });

  it('ignores utterance definite without ending the recording', () => {
    const subject = normalizer();
    expect(
      subject.accept({ type: 'utteranceDefinite', text: '你好。' }),
    ).toBeNull();
    expect(subject.isTerminal).toBe(false);
    expect(
      subject.accept({ type: 'partial', text: '你好，世界' }),
    ).not.toBeNull();
  });

  it('accepts exactly one final after markFinalizing', () => {
    const subject = normalizer();
    subject.accept({ type: 'partial', text: '你好' });
    subject.markFinalizing();
    const final = subject.accept({ type: 'final', text: '你好，世界。' });
    expect(final).toEqual({
      type: 'asr.final',
      asrStreamId: 'asr_1',
      sequence: 2,
      text: '你好，世界。',
    });
    expect(subject.accept({ type: 'final', text: '重复' })).toBeNull();
  });

  it('maps a provider final before finalizing to ASR_PROVIDER_ENDED', () => {
    const subject = normalizer();
    const event = subject.accept({ type: 'final', text: '提前结束' });
    expect(event).toEqual({
      type: 'asr.error',
      asrStreamId: 'asr_1',
      code: 'ASR_PROVIDER_ENDED',
      retryable: false,
      safeMessage: 'ASR_PROVIDER_ENDED',
    });
    expect(subject.isTerminal).toBe(true);
    expect(subject.close('provider_ended')).toEqual([
      { type: 'asr.closed', asrStreamId: 'asr_1', reason: 'provider_ended' },
    ]);
  });

  it('rejects blank and oversized finals with safe errors', () => {
    const blank = normalizer();
    blank.markFinalizing();
    expect(blank.accept({ type: 'final', text: '   ' })).toEqual({
      type: 'asr.error',
      asrStreamId: 'asr_1',
      code: 'ASR_EMPTY_RESULT',
      retryable: false,
      safeMessage: 'ASR_EMPTY_RESULT',
    });

    const oversized = normalizer(8);
    oversized.markFinalizing();
    const event = oversized.accept({ type: 'final', text: '中'.repeat(4) });
    expect(event).toEqual({
      type: 'asr.error',
      asrStreamId: 'asr_1',
      code: 'ASR_RESULT_TOO_LARGE',
      retryable: false,
      safeMessage: 'ASR_RESULT_TOO_LARGE',
    });
    expect(DEFAULT_MAX_FINAL_BYTES).toBe(16384);
  });

  it('cancels once and closes immediately', () => {
    const subject = normalizer();
    expect(types(subject.cancel('user'))).toEqual([
      'asr.cancelled',
      'asr.closed',
    ]);
    expect(subject.isTerminal).toBe(true);
    expect(subject.cancel('user')).toEqual([]);
    expect(subject.accept({ type: 'partial', text: '迟到' })).toBeNull();
  });

  it('fails once with error followed by closed', () => {
    const subject = normalizer();
    const events = subject.fail('ASR_FINAL_TIMEOUT', true);
    expect(types(events)).toEqual(['asr.error', 'asr.closed']);
    expect(events[1]).toEqual({
      type: 'asr.closed',
      asrStreamId: 'asr_1',
      reason: 'error',
    });
    expect(subject.fail('ASR_FINAL_TIMEOUT', true)).toEqual([]);
  });

  it('closes once and drops every later provider event', () => {
    const subject = normalizer();
    expect(types(subject.close('completed'))).toEqual(['asr.closed']);
    expect(subject.close('completed')).toEqual([]);
    expect(subject.accept({ type: 'partial', text: '迟到' })).toBeNull();
  });

  it('never emits more than one terminal outcome', () => {
    const subject = normalizer();
    subject.fail('ASR_PROVIDER_ERROR', true);
    expect(subject.cancel('user')).toEqual([]);
    expect(subject.close('completed')).toEqual([]);
  });
});