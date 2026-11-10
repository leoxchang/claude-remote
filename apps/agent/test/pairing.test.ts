import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PairingService } from '../src/pairing/pairing-service.js';
import { DeviceStore } from '../src/store/device-store.js';

const BASE_URL = 'https://macbook.example-tailnet.ts.net';
const PAIRING_TTL_MS = 5 * 60 * 1000;

interface Harness {
  service: PairingService;
  store: DeviceStore;
  configDir: string;
  advance: (ms: number) => void;
}

async function harness(): Promise<Harness> {
  const configDir = await mkdtemp(join(tmpdir(), 's01-pairing-'));
  const store = new DeviceStore(configDir);
  let currentTime = Date.UTC(2026, 10, 10, 0, 0, 0);
  const service = new PairingService({
    deviceStore: store,
    desktopId: 'desktop_test',
    baseUrl: BASE_URL,
    now: () => currentTime,
  });
  return {
    service,
    store,
    configDir,
    advance: (ms: number) => {
      currentTime += ms;
    },
  };
}

const consumeInput = (
  payload: { pairingId: string; code: string },
  overrides: Record<string, unknown> = {},
): Parameters<PairingService['consume']>[0] => ({
  pairingId: payload.pairingId,
  code: payload.code,
  deviceName: 'iPhone',
  appVersion: '0.1.0',
  supportedProtocolVersions: [1],
  ...overrides,
});

describe('PairingService.begin', () => {
  it('returns a qr payload with only the allowed fields', async () => {
    const { service } = await harness();

    const payload = service.begin();

    expect(Object.keys(payload).sort()).toEqual([
      'baseUrl',
      'code',
      'expiresAt',
      'pairingId',
      'v',
    ]);
    expect(payload.v).toBe(1);
    expect(payload.baseUrl).toBe(BASE_URL);
    expect(payload.pairingId).toMatch(/^pair_/);
    expect(payload.code).toHaveLength(43);
    expect(payload.expiresAt).toBe(Date.UTC(2026, 10, 10, 0, 0, 0) + PAIRING_TTL_MS);
  });

  it('refuses a new pairing while a device is already bound', async () => {
    const { service } = await harness();
    const payload = service.begin();
    await service.consume(consumeInput(payload));

    let thrown: unknown;
    try {
      service.begin();
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'DEVICE_ALREADY_PAIRED' });
  });

  it('allows an explicit replace while a device is bound', async () => {
    const { service, store } = await harness();
    const first = service.begin();
    const firstDevice = await service.consume(consumeInput(first));

    const second = service.begin(true);
    const secondDevice = await service.consume(consumeInput(second));

    expect(secondDevice.deviceId).not.toBe(firstDevice.deviceId);
    expect(await store.verify(firstDevice.deviceId, firstDevice.deviceToken)).toBeNull();
  });
});

describe('PairingService.consume', () => {
  it('binds a device and persists only the token hash', async () => {
    const { service, store, configDir } = await harness();
    const payload = service.begin();

    const result = await service.consume(consumeInput(payload));

    expect(result).toEqual({
      deviceId: expect.stringMatching(/^device_/),
      deviceToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      desktopId: 'desktop_test',
      protocolVersion: 1,
    });
    const raw = await readFile(join(configDir, 'devices.json'), 'utf8');
    expect(raw).not.toContain(result.deviceToken);
    expect(await store.verify(result.deviceId, result.deviceToken)).not.toBeNull();
  });

  it('consumes the code exactly once', async () => {
    const { service } = await harness();
    const payload = service.begin();
    await service.consume(consumeInput(payload));

    await expect(service.consume(consumeInput(payload))).rejects.toMatchObject({
      code: 'PAIRING_FAILED',
    });
  });

  it('rejects an expired pairing', async () => {
    const { service, advance } = await harness();
    const payload = service.begin();
    advance(PAIRING_TTL_MS + 1);

    await expect(service.consume(consumeInput(payload))).rejects.toMatchObject({
      code: 'PAIRING_EXPIRED',
    });
  });

  it('invalidates the pairing after five wrong codes', async () => {
    const { service } = await harness();
    const payload = service.begin();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        service.consume(consumeInput(payload, { code: 'wrong-code' })),
      ).rejects.toMatchObject({ code: 'PAIRING_FAILED' });
    }

    await expect(service.consume(consumeInput(payload))).rejects.toMatchObject({
      code: 'PAIRING_FAILED',
    });
  });

  it('rejects unsupported protocol versions', async () => {
    const { service } = await harness();
    const payload = service.begin();

    await expect(
      service.consume(consumeInput(payload, { supportedProtocolVersions: [2] })),
    ).rejects.toMatchObject({ code: 'VERSION_INCOMPATIBLE' });
  });

  it('applies one global window regardless of device name', async () => {
    const { service } = await harness();
    const attempts = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const payload = service.begin();
      attempts.push(service.consume(consumeInput(payload, { code: 'wrong-code', deviceName: `Phone ${attempt}` })));
    }
    await Promise.allSettled(attempts);

    const payload = service.begin();
    await expect(service.consume(consumeInput(payload))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('releases the rate limit window after one minute', async () => {
    const { service, advance } = await harness();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const payload = service.begin();
      await service.consume(consumeInput(payload, { code: 'wrong-code' })).catch(() => undefined);
    }

    advance(60 * 1000 + 1);
    const payload = service.begin();

    await expect(service.consume(consumeInput(payload))).resolves.toMatchObject({
      protocolVersion: 1,
    });
  });
});