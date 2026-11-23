import { Buffer } from 'node:buffer';

import { afterEach, describe, expect, it, Mock, vi } from 'vitest';

import { AgentLogger } from '../../src/app/logger.js';
import {
  createRelayConnector,
  RelayHttpDispatch,
} from '../../src/relay/connector.js';
import { RelayLink, startRelayLink } from '../../src/relay/link.js';
import { createTrustedDevices } from '../../src/relay/trusted-devices.js';
import { ConnectionManager } from '../../src/transport/connection-manager.js';
import { FakeRelay, startFakeRelay } from './fake-relay.js';

const SILENT_LOGGER: AgentLogger = { info() {}, warn() {} };
const FAST_BACKOFF = { baseMs: 20, maxMs: 40 };

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let relay: FakeRelay | null = null;
let link: RelayLink | null = null;

afterEach(async () => {
  link?.stop();
  link = null;
  await relay?.stop();
  relay = null;
});

async function setupWithDispatch(
  dispatch: Mock<RelayHttpDispatch>,
): Promise<FakeRelay> {
  relay = await startFakeRelay();
  const manager = new ConnectionManager({
    desktopId: 'desk_test',
    agentInstanceId: 'agent_test',
    versions: { agent: '0.0.0', sdk: 'x', runtime: 'x' },
    capabilities: [],
  });
  const connector = createRelayConnector({
    connections: manager,
    relayDevices: createTrustedDevices(() => false),
    asrAccept: () => {},
    httpDispatch: dispatch,
    logger: SILENT_LOGGER,
  });
  link = startRelayLink({
    baseUrl: relay.httpBase,
    credential: { deviceId: 'dev_desktop', deviceToken: 'tok' },
    hello: {
      appVersion: '0.0.0',
      desktopName: 'Dispatch Mac',
      platform: 'macos',
      supportedContractVersions: [1],
    },
    handlers: connector.handlers,
    logger: SILENT_LOGGER,
    backoff: FAST_BACKOFF,
  });
  connector.attachLink(link);
  await waitUntil(() => link?.state().status === 'ready');
  return relay;
}

describe('connector http.request 分发', () => {
  it('分发入参完整透传，结果编码为 http.response', async () => {
    const dispatch = vi.fn<RelayHttpDispatch>(() => ({
      status: 200,
      contentType: 'text/plain',
      body: Buffer.from('ok'),
    }));
    const fakeRelay = await setupWithDispatch(dispatch);
    const requestBody = Buffer.from('{"mediaType":"image/png"}');
    fakeRelay.send({
      type: 'http.request',
      payload: {
        requestId: 'req_1',
        deviceId: 'dev_phone',
        method: 'POST',
        path: '/v1/attachments',
        contentType: 'application/json',
        bodyBase64: requestBody.toString('base64'),
      },
    });
    const response = await fakeRelay.waitForMessage(
      (message) => message['type'] === 'http.response',
    );
    expect(dispatch).toHaveBeenCalledWith({
      deviceId: 'dev_phone',
      method: 'POST',
      path: '/v1/attachments',
      contentType: 'application/json',
      body: requestBody,
    });
    expect(response['payload']).toEqual({
      requestId: 'req_1',
      status: 200,
      contentType: 'text/plain',
      bodyBase64: Buffer.from('ok').toString('base64'),
    });
  });

  it('分发抛错 → 500 INTERNAL_ERROR 且连接存活', async () => {
    const dispatch = vi.fn<RelayHttpDispatch>(() => {
      throw new Error('boom');
    });
    const fakeRelay = await setupWithDispatch(dispatch);
    fakeRelay.send({
      type: 'http.request',
      payload: {
        requestId: 'req_2',
        deviceId: 'dev_phone',
        method: 'GET',
        path: '/v1/runs/r1/prompt',
      },
    });
    const response = await fakeRelay.waitForMessage(
      (message) => message['type'] === 'http.response',
    );
    const payload = response['payload'] as {
      status: number;
      bodyBase64: string;
    };
    expect(payload.status).toBe(500);
    expect(
      JSON.parse(Buffer.from(payload.bodyBase64, 'base64').toString('utf8')),
    ).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'INTERNAL_ERROR' } });
    expect(link?.state().status).toBe('ready');
  });
});