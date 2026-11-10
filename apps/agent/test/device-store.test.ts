import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { randomBase64Url, sha256Base64Url } from '../src/security/random.js';
import { DeviceStore } from '../src/store/device-store.js';

async function createStore(): Promise<{ configDir: string; store: DeviceStore }> {
  const configDir = await mkdtemp(join(tmpdir(), 's01-devices-'));
  return { configDir, store: new DeviceStore(configDir) };
}

describe('randomBase64Url', () => {
  it('returns the requested number of random bytes as base64url', () => {
    expect(randomBase64Url()).toHaveLength(43);
    expect(randomBase64Url(16)).toHaveLength(22);
    expect(randomBase64Url()).not.toBe(randomBase64Url());
  });
});

describe('sha256Base64Url', () => {
  it('is stable and does not contain the input', () => {
    const hash = sha256Base64Url('device-token');

    expect(hash).toBe(sha256Base64Url('device-token'));
    expect(hash).not.toContain('device-token');
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('DeviceStore', () => {
  it('persists only the token hash with a 0600 file', async () => {
    const { configDir, store } = await createStore();
    const token = randomBase64Url();
    const tokenHash = sha256Base64Url(token);

    await store.create('device_01', 'iPhone', tokenHash);

    const filePath = join(configDir, 'devices.json');
    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain(tokenHash);
    expect(raw).not.toContain(token);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('accepts the matching token and rejects any other token', async () => {
    const { store } = await createStore();
    const token = randomBase64Url();
    await store.create('device_01', 'iPhone', sha256Base64Url(token));

    expect(await store.verify('device_01', token)).toMatchObject({
      deviceId: 'device_01',
      revokedAt: null,
    });
    expect(await store.verify('device_01', randomBase64Url())).toBeNull();
    expect(await store.verify('device_missing', token)).toBeNull();
  });

  it('returns the single active device', async () => {
    const { store } = await createStore();
    expect(store.active()).toBeNull();

    await store.create('device_01', 'iPhone', sha256Base64Url(randomBase64Url()));

    expect(store.active()).toMatchObject({ deviceId: 'device_01' });
  });

  it('revokes a device and makes it unusable', async () => {
    const { store } = await createStore();
    const token = randomBase64Url();
    await store.create('device_01', 'iPhone', sha256Base64Url(token));

    const revoked = await store.revoke('device_01');

    expect(revoked.revokedAt).not.toBeNull();
    expect(await store.verify('device_01', token)).toBeNull();
    expect(store.active()).toBeNull();
  });

  it('fails when revoking an unknown device', async () => {
    const { store } = await createStore();

    await expect(store.revoke('device_missing')).rejects.toThrow(/unknown|missing/i);
  });

  it('does not expose its internal record through the returned value', async () => {
    const { store } = await createStore();
    const record = await store.create('device_01', 'iPhone', sha256Base64Url(randomBase64Url()));

    record.deviceName = 'mutated';

    expect(store.active()).toMatchObject({ deviceName: 'iPhone' });
  });
});