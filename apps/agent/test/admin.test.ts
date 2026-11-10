import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AdminClient } from '../src/admin/client.js';
import { AdminStatus, createAdminServer } from '../src/admin/server.js';
import { PairingService } from '../src/pairing/pairing-service.js';
import { DeviceStore } from '../src/store/device-store.js';

const BASE_URL = 'https://macbook.example-tailnet.ts.net';

const runningServers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

interface AdminHarness {
  client: AdminClient;
  server: FastifyInstance;
  store: DeviceStore;
  pairingService: PairingService;
  revoked: string[];
  socketPath: string;
}

async function startAdmin(): Promise<AdminHarness> {
  const configDir = await mkdtemp(join(tmpdir(), 's01-admin-'));
  const store = new DeviceStore(configDir);
  const socketPath = join(configDir, 'agent.sock');
  const pairingService = new PairingService({
    deviceStore: store,
    desktopId: 'desktop_test',
    baseUrl: BASE_URL,
  });
  const status: AdminStatus = {
    status: 'running',
    desktopId: 'desktop_test',
    listen: { host: '127.0.0.1', port: 8787 },
    activeDeviceId: null,
  };
  const revoked: string[] = [];
  const server = await createAdminServer({
    socketPath,
    pairingService,
    deviceStore: store,
    getStatus: () => status,
    onRevoke: (deviceId) => revoked.push(deviceId),
  });
  runningServers.push(server);
  return {
    client: new AdminClient(socketPath),
    server,
    store,
    pairingService,
    revoked,
    socketPath,
  };
}

describe('createAdminServer', () => {
  it('listens only on a unix socket with restrictive modes', async () => {
    const { server, socketPath } = await startAdmin();

    expect(server.server.address()).toBe(socketPath);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(socketPath)).isSocket()).toBe(true);
  });

  it('replaces a stale socket file before listening', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 's01-stale-'));
    const socketPath = join(configDir, 'agent.sock');
    await writeFile(socketPath, 'stale');
    const store = new DeviceStore(configDir);
    const server = await createAdminServer({
      socketPath,
      pairingService: new PairingService({
        deviceStore: store,
        desktopId: 'desktop_test',
        baseUrl: BASE_URL,
      }),
      deviceStore: store,
      getStatus: () => ({
        status: 'running',
        desktopId: 'desktop_test',
        listen: { host: '127.0.0.1', port: 8787 },
        activeDeviceId: null,
      }),
      onRevoke: () => undefined,
    });
    runningServers.push(server);

    expect((await stat(socketPath)).isSocket()).toBe(true);
  });

  it('refuses to steal an active socket', async () => {
    const { socketPath, store } = await startAdmin();

    await expect(
      createAdminServer({
        socketPath,
        pairingService: new PairingService({
          deviceStore: store,
          desktopId: 'desktop_test',
          baseUrl: BASE_URL,
        }),
        deviceStore: store,
        getStatus: () => ({
          status: 'running',
          desktopId: 'desktop_test',
          listen: { host: '127.0.0.1', port: 8787 },
          activeDeviceId: null,
        }),
        onRevoke: () => undefined,
      }),
    ).rejects.toThrow(/active/i);
  });
});

describe('AdminClient', () => {
  it('reads status and devices', async () => {
    const { client } = await startAdmin();

    expect(await client.status()).toMatchObject({
      status: 'running',
      desktopId: 'desktop_test',
    });
    expect(await client.devices()).toEqual([]);
  });

  it('starts a pairing through the running agent', async () => {
    const { client } = await startAdmin();

    const payload = await client.pair();

    expect(payload).toMatchObject({ v: 1, baseUrl: BASE_URL });
    expect(payload.code).toHaveLength(43);
  });

  it('revokes a device and notifies the connection layer', async () => {
    const { client, store, revoked } = await startAdmin();
    const record = await store.create('device_01', 'iPhone', 'hash');

    const result = await client.revoke(record.deviceId);

    expect(result).toMatchObject({
      deviceId: 'device_01',
      revokedAt: expect.any(String),
    });
    expect(await client.devices()).toEqual([
      expect.objectContaining({ deviceId: 'device_01', revokedAt: expect.any(String) }),
    ]);
    expect(revoked).toEqual(['device_01']);
  });

  it('returns a structured error for an unknown device', async () => {
    const { client } = await startAdmin();

    await expect(client.revoke('device_missing')).rejects.toMatchObject({
      code: 'DEVICE_NOT_FOUND',
    });
  });
});