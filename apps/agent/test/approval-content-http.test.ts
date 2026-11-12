import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApprovalContentController,
  ApprovalContentRateLimiter,
} from '../src/approval/approval-content-controller.js';
import { EventJournal } from '../src/events/journal.js';
import { PairingService } from '../src/pairing/pairing-service.js';
import { sha256Base64Url } from '../src/security/random.js';
import { DeviceStore } from '../src/store/device-store.js';
import { createPhoneServer } from '../src/transport/phone-server.js';
import {
  BrokerHarness,
  makeRequest,
  setupBroker,
} from './approval-test-harness.js';

const BASE_URL = 'https://macbook.example-tailnet.ts.net';
const TOKEN_ONE = 'token-one';
const TOKEN_TWO = 'token-two';

let configDir: string;
let server: FastifyInstance | null = null;
let deviceStore: DeviceStore | null = null;
let harness: BrokerHarness;
let journal: EventJournal;

async function startServer(): Promise<{
  server: FastifyInstance;
  controller: ApprovalContentController;
}> {
  const store = new DeviceStore(configDir);
  deviceStore = store;
  await store.create('device_1', 'iPhone', sha256Base64Url(TOKEN_ONE));
  await store.create('device_2', 'iPad', sha256Base64Url(TOKEN_TWO));
  const controller = new ApprovalContentController({
    store: harness.store,
    settleExpired: (approvalId) => {
      harness.broker.settleIfExpired(approvalId);
    },
    rateLimiter: new ApprovalContentRateLimiter(),
    clock: harness.clock,
  });
  server = await createPhoneServer({
    pairingService: new PairingService({
      deviceStore: store,
      desktopId: 'desktop_test',
      baseUrl: BASE_URL,
    }),
    deviceStore: store,
    workspace: { workspaceId: 'ws_a', displayName: 'Fixture Alpha' },
    onConnection: () => undefined,
    approvalContent: controller,
  });
  return { server, controller };
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer device_1.${token}` };
}

/** app.inject 返回的响应子集；只读取状态、头与正文。 */
interface Response {
  statusCode: number;
  headers: Record<string, unknown>;
  json(): Record<string, unknown>;
  body: string;
}

async function getContent(
  approvalId: string,
  chunkIndex: string | number,
  headers: Record<string, string>,
): Promise<Response> {
  const app = server;
  if (app === null) throw new Error('server not started');
  return app.inject({
    method: 'GET',
    url: `/v1/approvals/${approvalId}/content?chunkIndex=${String(chunkIndex)}`,
    headers,
  });
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 's03-content-http-'));
  harness = setupBroker();
  journal = new EventJournal();
});

afterEach(async () => {
  await server?.close();
  server = null;
  await rm(configDir, { recursive: true, force: true });
});

describe('GET /v1/approvals/:id/content', () => {
  it('serves authenticated no-store chunks that reassemble exactly', async () => {
    await startServer();
    harness.broker.request(
      'run_1',
      makeRequest({ input: { command: 'echo 中文🙂', description: 'fixture' } }),
    );
    const record = harness.store.getById('approval_1');
    const content = record?.content;
    if (content === null || content === undefined) {
      throw new Error('fixture pending must have content');
    }

    const texts: string[] = [];
    for (let index = 0; index < content.chunks.length; index += 1) {
      const response = await getContent(
        'approval_1',
        index,
        authHeader(TOKEN_ONE),
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json();
      expect(body).toMatchObject({
        approvalId: 'approval_1',
        chunkIndex: index,
        chunkCount: content.chunks.length,
        encoding: 'json-utf8',
        byteLength: content.byteLength,
        sha256: content.sha256,
      });
      texts.push(String(body['text']));
    }

    expect(texts.join('')).toBe(content.jsonText);
    expect(sha256Base64Url(texts.join(''))).toBe(content.sha256);
  });

  it('rejects missing, malformed and unknown tokens with 401', async () => {
    await startServer();
    harness.broker.request('run_1', makeRequest());

    const missing = await getContent('approval_1', 0, {});
    const malformed = await getContent('approval_1', 0, {
      authorization: 'Basic abc',
    });
    const wrong = await getContent('approval_1', 0, {
      authorization: 'Bearer device_1.wrong-token',
    });

    for (const response of [missing, malformed, wrong]) {
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(TOKEN_ONE);
      expect(response.json()).toMatchObject({
        error: { code: 'UNAUTHENTICATED' },
      });
    }
  });

  it('rejects a different authenticated device with 403', async () => {
    await startServer();
    harness.broker.request('run_1', makeRequest());

    const response = await getContent('approval_1', 0, {
      authorization: `Bearer device_2.${TOKEN_TWO}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('rejects revoked devices with 401', async () => {
    await startServer();
    harness.broker.request('run_1', makeRequest());
    await deviceStore?.revoke('device_1');

    const response = await getContent('approval_1', 0, authHeader(TOKEN_ONE));

    expect(response.statusCode).toBe(401);
  });

  it('maps unknown approvals and malformed indexes to stable statuses', async () => {
    await startServer();
    harness.broker.request('run_1', makeRequest());

    expect(
      (await getContent('approval_missing', 0, authHeader(TOKEN_ONE)))
        .statusCode,
    ).toBe(404);
    for (const index of ['abc', '-1', '1.5', '01', '']) {
      const response = await getContent('approval_1', index, authHeader(TOKEN_ONE));
      expect(response.statusCode).toBe(400);
    }
  });

  it('rejects reads after resolution and after expiry', async () => {
    await startServer();
    harness.broker.request('run_1', makeRequest());
    harness.broker.respond({
      approvalId: 'approval_1',
      workspaceId: 'ws_a',
      sessionId: 'session_run_1',
      runId: 'run_1',
      deviceId: 'device_1',
      commandId: 'cmd_1',
      decision: 'deny',
    });

    const resolved = await getContent('approval_1', 0, authHeader(TOKEN_ONE));
    expect(resolved.statusCode).toBe(409);
    expect(resolved.json()).toMatchObject({
      error: { code: 'APPROVAL_ALREADY_RESOLVED' },
    });

    harness.broker.request(
      'run_1',
      makeRequest({ requestId: 'req_2', toolUseID: 'toolu_2' }),
    );
    harness.clock.advanceMonotonic(120_000);
    const expired = await getContent('approval_2', 0, authHeader(TOKEN_ONE));
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ error: { code: 'APPROVAL_EXPIRED' } });
  });

  it('is side-effect free for journal, record and pending counts', async () => {
    await startServer();
    harness.broker.request('run_1', makeRequest());
    const before = harness.store.getById('approval_1');
    const seqBefore = journal.lastSeq('session_run_1');
    const pendingBefore = harness.store.globalPendingCount();

    const response = await getContent('approval_1', 0, authHeader(TOKEN_ONE));

    expect(response.statusCode).toBe(200);
    expect(journal.lastSeq('session_run_1')).toBe(seqBefore);
    expect(harness.store.getById('approval_1')).toBe(before);
    expect(harness.store.globalPendingCount()).toBe(pendingBefore);
    expect(harness.events.resolvedEvents).toHaveLength(0);
  });
});