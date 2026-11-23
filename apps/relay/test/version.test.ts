import { describe, expect, it } from 'vitest';

import { createRelayApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_LIMITS } from '../src/limits.js';

describe('GET /v1/version', () => {
  it('免鉴权返回契约版本', async () => {
    const app = await createRelayApp({ logger: false });
    const response = await app.inject({ method: 'GET', url: '/v1/version' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ contractVersion: 1 });
    await app.close();
  });
});

describe('loadConfig', () => {
  it('默认值与环境变量覆盖', () => {
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 8788,
      dataDir: './data',
    });
    expect(loadConfig({ RELAY_PORT: '0' }).port).toBe(0);
    expect(() => loadConfig({ RELAY_PORT: 'abc' })).toThrow('INVALID_CONFIG');
  });
});

it('DEFAULT_LIMITS 与契约 §2.1 一致', () => {
  expect(DEFAULT_LIMITS.controlFrameBytes).toBe(65536);
  expect(DEFAULT_LIMITS.maxDevicesPerAccount).toBe(20);
  expect(DEFAULT_LIMITS.httpTimeoutMs).toBe(30000);
});