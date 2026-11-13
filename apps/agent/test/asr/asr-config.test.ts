import { describe, expect, it } from 'vitest';

import { AsrError } from '../../src/asr/asr-protocol.js';
import {
  AsrResourceId,
  DEFAULT_DOUBAO_RESOURCE_ID,
  DOUBAO_ASR_ENDPOINT,
  loadAsrConfig,
} from '../../src/asr/asr-config.js';

describe('loadAsrConfig', () => {
  it('returns null when the API key is missing or empty', () => {
    expect(loadAsrConfig({})).toBeNull();
    expect(loadAsrConfig({ DOUBAO_ASR_API_KEY: '' })).toBeNull();
  });

  it('defaults to the duration resource id', () => {
    const config = loadAsrConfig({ DOUBAO_ASR_API_KEY: 'key_1' });
    expect(config).toEqual({
      provider: 'doubao',
      apiKey: 'key_1',
      resourceId: DEFAULT_DOUBAO_RESOURCE_ID,
    });
  });

  it('accepts the concurrent resource id', () => {
    const config = loadAsrConfig({
      DOUBAO_ASR_API_KEY: 'key_1',
      DOUBAO_ASR_RESOURCE_ID: 'volc.seedasr.sauc.concurrent',
    });
    expect(config?.resourceId).toBe('volc.seedasr.sauc.concurrent');
  });

  it('rejects an unknown resource id with a safe error', () => {
    let captured: unknown;
    try {
      loadAsrConfig({
        DOUBAO_ASR_API_KEY: 'key_1',
        DOUBAO_ASR_RESOURCE_ID: 'legacy-model',
      });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(AsrError);
    expect((captured as AsrError).code).toBe('ASR_NOT_CONFIGURED');
    expect((captured as AsrError).message).not.toContain('key_1');
    expect((captured as AsrError).message).not.toContain('legacy-model');
  });

  it('only exposes the provider, key and resource id', () => {
    const config = loadAsrConfig({
      DOUBAO_ASR_API_KEY: 'key_1',
      DOUBAO_ASR_APP_ID: 'forbidden',
      DOUBAO_ASR_ACCESS_TOKEN: 'forbidden',
    });
    expect(Object.keys(config ?? {}).sort()).toEqual([
      'apiKey',
      'provider',
      'resourceId',
    ]);
  });

  it('pins the official endpoint as a constant', () => {
    expect(DOUBAO_ASR_ENDPOINT).toBe(
      'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
    );
    const resourceId: AsrResourceId = DEFAULT_DOUBAO_RESOURCE_ID;
    expect(resourceId).toBe('volc.seedasr.sauc.duration');
  });
});