import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AttachmentStore } from '../src/attachment/attachment-store.js';
import { PairingService } from '../src/pairing/pairing-service.js';
import { sha256Base64Url } from '../src/security/random.js';
import { DeviceStore } from '../src/store/device-store.js';
import { createPhoneServer } from '../src/transport/phone-server.js';

const TOKEN = 'token-one';
const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');

let configDir: string;
let attachmentsRoot: string;
let server: FastifyInstance;
let deviceStore: DeviceStore;

async function start(attachments?: AttachmentStore): Promise<void> {
  deviceStore = new DeviceStore(configDir);
  await deviceStore.create('device_1', 'iPhone', sha256Base64Url(TOKEN));
  server = await createPhoneServer({
    pairingService: new PairingService({
      deviceStore,
      desktopId: 'desktop_test',
      baseUrl: 'http://192.168.5.128:8787',
    }),
    deviceStore,
    workspace: { workspaceId: 'ws_a', displayName: 'Fixture Alpha' },
    onConnection: () => undefined,
    ...(attachments === undefined ? {} : { attachments }),
  });
}

function auth(): Record<string, string> {
  return {
    authorization: `Bearer device_1.${TOKEN}`,
    'content-type': 'application/json',
  };
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 's06-attach-http-'));
  attachmentsRoot = await mkdtemp(join(tmpdir(), 's06-attach-files-'));
});

afterEach(async () => {
  await server.close();
  await rm(configDir, { recursive: true, force: true });
  await rm(attachmentsRoot, { recursive: true, force: true });
});

describe('POST /v1/attachments', () => {
  it('stores an authenticated jpeg upload', async () => {
    const attachments = new AttachmentStore(attachmentsRoot);
    await start(attachments);

    const response = await server.inject({
      method: 'POST',
      url: '/v1/attachments',
      headers: auth(),
      payload: { mediaType: 'image/jpeg', dataBase64: JPEG_BASE64 },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as Record<string, unknown>;
    expect(body['attachmentId']).toMatch(/^att_/);
    expect(body['mediaType']).toBe('image/jpeg');
    expect(JSON.stringify(body)).not.toContain(attachmentsRoot);
  });

  it('rejects a request without a device token', async () => {
    await start(new AttachmentStore(attachmentsRoot));

    const response = await server.inject({
      method: 'POST',
      url: '/v1/attachments',
      headers: { 'content-type': 'application/json' },
      payload: { mediaType: 'image/jpeg', dataBase64: JPEG_BASE64 },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects bytes that do not match the declared type', async () => {
    await start(new AttachmentStore(attachmentsRoot));

    const response = await server.inject({
      method: 'POST',
      url: '/v1/attachments',
      headers: auth(),
      payload: {
        mediaType: 'image/png',
        dataBase64: JPEG_BASE64,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an unsupported media type', async () => {
    await start(new AttachmentStore(attachmentsRoot));

    const response = await server.inject({
      method: 'POST',
      url: '/v1/attachments',
      headers: auth(),
      payload: { mediaType: 'image/gif', dataBase64: JPEG_BASE64 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 404 when attachments are not wired', async () => {
    await start();

    const response = await server.inject({
      method: 'POST',
      url: '/v1/attachments',
      headers: auth(),
      payload: { mediaType: 'image/jpeg', dataBase64: JPEG_BASE64 },
    });

    expect(response.statusCode).toBe(404);
  });
});