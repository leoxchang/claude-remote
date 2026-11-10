import { mkdtemp } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { PairingService } from '../src/pairing/pairing-service.js';
import { DeviceStore } from '../src/store/device-store.js';
import { authenticateUpgrade } from '../src/transport/authenticate.js';
import { createPhoneServer } from '../src/transport/phone-server.js';

const BASE_URL = 'https://macbook.example-tailnet.ts.net';

const runningApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.close()));
});

interface Harness {
  app: FastifyInstance;
  store: DeviceStore;
  pairingService: PairingService;
  connections: string[];
}

async function harness(now?: () => number): Promise<Harness> {
  const configDir = await mkdtemp(join(tmpdir(), 's01-phone-'));
  const store = new DeviceStore(configDir);
  const pairingService = new PairingService({
    deviceStore: store,
    desktopId: 'desktop_test',
    baseUrl: BASE_URL,
    ...(now === undefined ? {} : { now }),
  });
  const connections: string[] = [];
  const app = await createPhoneServer({
    pairingService,
    deviceStore: store,
    workspace: { workspaceId: 'default', displayName: 'S01 Fixture' },
    onConnection: (_socket, device) => {
      connections.push(device.deviceId);
    },
  });
  runningApps.push(app);
  return { app, store, pairingService, connections };
}

const pairBody = (payload: { pairingId: string; code: string }) => ({
  pairingId: payload.pairingId,
  code: payload.code,
  deviceName: 'iPhone',
  appVersion: '0.1.0',
  supportedProtocolVersions: [1],
});

describe('authenticateUpgrade', () => {
  it('resolves the device for a valid bearer token', async () => {
    const { store, pairingService } = await harness();
    const consumed = await pairingService.consume(pairBody(pairingService.begin()));

    const device = await authenticateUpgrade(
      { authorization: `Bearer ${consumed.deviceId}.${consumed.deviceToken}` },
      store,
    );

    expect(device.deviceId).toBe(consumed.deviceId);
  });

  it('rejects a missing header', async () => {
    const { store } = await harness();

    await expect(authenticateUpgrade({}, store)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects a bearer token that is not deviceId.token', async () => {
    const { store } = await harness();

    await expect(
      authenticateUpgrade({ authorization: 'Bearer only-a-token' }, store),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a wrong token', async () => {
    const { store, pairingService } = await harness();
    const consumed = await pairingService.consume(pairBody(pairingService.begin()));

    await expect(
      authenticateUpgrade(
        { authorization: `Bearer ${consumed.deviceId}.wrong-token` },
        store,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a revoked device', async () => {
    const { store, pairingService } = await harness();
    const consumed = await pairingService.consume(pairBody(pairingService.begin()));
    await store.revoke(consumed.deviceId);

    await expect(
      authenticateUpgrade(
        { authorization: `Bearer ${consumed.deviceId}.${consumed.deviceToken}` },
        store,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('POST /v1/pairings', () => {
  it('returns the pairing result once', async () => {
    const { app, pairingService } = await harness();
    const payload = pairingService.begin();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/pairings',
      payload: pairBody(payload),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      deviceId: expect.stringMatching(/^device_/),
      deviceToken: expect.any(String),
      desktopId: 'desktop_test',
      workspace: { workspaceId: 'default', displayName: 'S01 Fixture' },
      protocolVersion: 1,
    });
  });

  it('answers PAIRING_FAILED without echoing the submitted code', async () => {
    const { app, pairingService } = await harness();
    const payload = pairingService.begin();
    const wrongCode = 'DO_NOT_ECHO_THIS_CODE';

    const response = await app.inject({
      method: 'POST',
      url: '/v1/pairings',
      payload: { ...pairBody(payload), code: wrongCode },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'PAIRING_FAILED', message: 'PAIRING_FAILED' },
    });
    expect(response.body).not.toContain(wrongCode);
  });

  it('answers PAIRING_EXPIRED after the five minute window', async () => {
    let currentTime = Date.UTC(2026, 10, 10, 0, 0, 0);
    const { app, pairingService } = await harness(() => currentTime);
    const payload = pairingService.begin();
    currentTime += 5 * 60 * 1000 + 1;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/pairings',
      payload: pairBody(payload),
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      error: { code: 'PAIRING_EXPIRED' },
    });
  });

  it('answers RATE_LIMITED for the eleventh attempt in a minute', async () => {
    const { app, pairingService } = await harness();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const payload = pairingService.begin();
      await app.inject({
        method: 'POST',
        url: '/v1/pairings',
        payload: { ...pairBody(payload), code: 'wrong-code' },
      });
    }

    const payload = pairingService.begin();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/pairings',
      payload: pairBody(payload),
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});

describe('GET /ws', () => {
  it('rejects an unauthenticated upgrade with 401', async () => {
    const { app } = await harness();

    const result = await connect(await listenOnEphemeralPort(app), {});

    expect(result).toMatchObject({ opened: false, statusCode: 401 });
  });

  it('accepts an authenticated upgrade and hands the device to the connection layer', async () => {
    const { app, pairingService, connections } = await harness();
    const consumed = await pairingService.consume(pairBody(pairingService.begin()));

    const result = await connect(await listenOnEphemeralPort(app), {
      authorization: `Bearer ${consumed.deviceId}.${consumed.deviceToken}`,
    });

    expect(result.opened).toBe(true);
    expect(connections).toEqual([consumed.deviceId]);
    result.socket?.close();
  });
});

async function listenOnEphemeralPort(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}/ws`;
}

interface ConnectionResult {
  opened: boolean;
  statusCode?: number;
  socket?: WebSocket;
}

function connect(
  url: string,
  headers: Record<string, string>,
): Promise<ConnectionResult> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    socket.on('open', () => resolve({ opened: true, socket }));
    socket.on('unexpected-response', (_request, response) =>
      resolve({ opened: false, statusCode: response.statusCode }),
    );
    socket.on('error', () => resolve({ opened: false }));
  });
}
describe('POST /v1/pairings validation', () => {
  it('rejects an incomplete body', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/pairings',
      payload: { pairingId: 'pair_1' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_MESSAGE' },
    });
  });

  it('rejects a pairing while a device is bound', async () => {
    const { app, pairingService, store } = await harness();
    const payload = pairingService.begin();
    await store.create('device_other', 'iPad', 'hash');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/pairings',
      payload: pairBody(payload),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'DEVICE_ALREADY_PAIRED' },
    });
  });
});
