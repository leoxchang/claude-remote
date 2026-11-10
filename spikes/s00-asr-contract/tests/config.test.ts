import { describe, expect, it } from 'vitest';

import { parseAsrConfig } from '../src/config.js';
import { recordEvidenceIfEnabled } from '../../../scripts/s00/evidence.js';

const SECRET_TOKEN = 'doubao-secret-token-4f81';

const completeEnv = {
  ASR_PROVIDER: 'doubao',
  DOUBAO_ASR_APP_ID: 'app_01',
  DOUBAO_ASR_ACCESS_TOKEN: SECRET_TOKEN,
  DOUBAO_ASR_RESOURCE_ID: 'resource_01',
  DOUBAO_ASR_ENDPOINT: 'wss://asr.example.test/v1',
} satisfies NodeJS.ProcessEnv;

describe('parseAsrConfig', () => {
  it('parses the complete Doubao placeholder configuration', () => {
    const config = parseAsrConfig(completeEnv);

    expect(config).toEqual({
      provider: 'doubao',
      appId: 'app_01',
      accessToken: SECRET_TOKEN,
      resourceId: 'resource_01',
      endpoint: 'wss://asr.example.test/v1',
    });
  });

  it('fails fast and names only the missing fields', () => {
    const env = {
      ...completeEnv,
      DOUBAO_ASR_RESOURCE_ID: '',
      DOUBAO_ASR_ENDPOINT: undefined,
    };

    expect(() => parseAsrConfig(env)).toThrow(/DOUBAO_ASR_RESOURCE_ID/);
    expect(() => parseAsrConfig(env)).toThrow(/DOUBAO_ASR_ENDPOINT/);
    try {
      parseAsrConfig(env);
    } catch (error: unknown) {
      expect(String(error)).not.toContain(SECRET_TOKEN);
    }
  });

  it('rejects an unsupported provider without echoing values', () => {
    const env = { ...completeEnv, ASR_PROVIDER: 'other-provider' };

    expect(() => parseAsrConfig(env)).toThrow(/ASR_PROVIDER/);
    try {
      parseAsrConfig(env);
    } catch (error: unknown) {
      expect(String(error)).not.toContain(SECRET_TOKEN);
    }
  });

  it('records ASR-07 evidence', async () => {
    let missingFieldsError = '';
    try {
      parseAsrConfig({ ...completeEnv, DOUBAO_ASR_ACCESS_TOKEN: '' });
    } catch (error: unknown) {
      missingFieldsError = error instanceof Error ? error.message : '';
    }
    await recordEvidenceIfEnabled({
      id: 'ASR-07',
      status:
        missingFieldsError.includes('DOUBAO_ASR_ACCESS_TOKEN') &&
        !missingFieldsError.includes(SECRET_TOKEN)
          ? 'PASS'
          : 'FAIL',
      summary: 'Missing ASR configuration fails fast with field names only',
      observedAt: new Date().toISOString(),
      data: { missingFields: ['DOUBAO_ASR_ACCESS_TOKEN'], secretLeaked: false },
    });
  });
});