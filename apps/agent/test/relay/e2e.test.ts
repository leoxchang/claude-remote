import { Buffer } from 'node:buffer';

import { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { WebSocket } from 'ws';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentLogger } from '../../src/app/logger.js';
import { createAsrRuntime, AsrRuntime } from '../../src/asr/asr-runtime.js';
import { createRelayConnector } from '../../src/relay/connector.js';
import { RelayLink, startRelayLink } from '../../src/relay/link.js';
import { createTrustedDevices } from '../../src/relay/trusted-devices.js';
import { ConnectionManager } from '../../src/transport/connection-manager.js';
import {
  login,
  RealRelay,
  startRealRelay,
} from './e2e-relay.js';

const SILENT_LOGGER: AgentLogger = { info() {}, warn() {} };
const PASSWORD = 'pw-123456';

const PHONE_HELLO = {
  protocolVersion: 1,
  messageId: 'msg_hello',
  timestamp: Date.now(),
  type: 'connection.hello',
  payload: {
    supportedProtocolVersions: [1],
    appVersion: '1.0.0',
    deviceId: 'ignored-by-agent',
    capabilities: [],
    handshakeId: 'hs_e2e',
  },
};

const ASR_START = {
  protocolVersion: 1,
  messageId: 'msg_asr_start',
  timestamp: Date.now(),
  type: 'asr.start',
  asrStreamId: 'asr_e2e',
  payload: {
    audio: { format: 'pcm-s16le', sampleRate: 16000, channels: 1 },
  },
};

let relay: RealRelay | null = null;
let link: RelayLink | null = null;
let app: FastifyInstance | null = null;
let asrRuntime: AsrRuntime | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  link?.stop();
  link = null;
  await app?.close();
  app = null;
  asrRuntime?.close('test_done');
  asrRuntime = null;
  await relay?.stop();
  relay = null;
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 7500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function connectPhone(url: string, authorization: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { authorization } });
    socket.once('open', () => {
      sockets.push(socket);
      resolve(socket);
    });
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`upgrade rejected: ${response.statusCode}`));
    });
    socket.once('error', reject);
  });
}

function nextFrame(
  socket: WebSocket,
  timeoutMs = 7500,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

interface AgentSide {
  baseUrl: string;
  desktopId: string;
  phoneAuthorization: string;
}

async function startAgentOverRelay(): Promise<AgentSide> {
  relay = await startRealRelay();
  await relay.runAdmin([
    'admin',
    'create-user',
    'alice',
    '--password',
    PASSWORD,
  ]);
  const desktop = (await login(relay.baseUrl, {
    username: 'alice',
    password: PASSWORD,
    clientType: 'desktop',
    deviceName: 'E2E Mac',
    platform: 'macos',
    appVersion: '0.0.0',
  })) as { deviceId: string; deviceToken: string };
  const phone = (await login(relay.baseUrl, {
    username: 'alice',
    password: PASSWORD,
    clientType: 'phone',
    deviceName: 'E2E iPhone',
    platform: 'ios',
    appVersion: '0.0.0',
  })) as { deviceId: string; deviceToken: string };

  app = Fastify({ logger: false });
  await app.register(websocket);
  asrRuntime = createAsrRuntime({
    app,
    env: {},
    authenticate: async () => null,
  });

  const manager = new ConnectionManager({
    desktopId: 'desk_e2e',
    agentInstanceId: 'agent_e2e',
    versions: { agent: '0.0.0', sdk: 'x', runtime: 'x' },
    capabilities: ['text'],
  });
  const connector = createRelayConnector({
    connections: manager,
    relayDevices: createTrustedDevices(() => false),
    asrAccept: (socket, deviceId) => {
      asrRuntime?.gateway.acceptAuthenticated(socket, deviceId);
    },
    httpDispatch: () => ({
      status: 404,
      contentType: 'application/json',
      body: Buffer.from('{"error":{"code":"ROUTE_NOT_FOUND"}}'),
    }),
    logger: SILENT_LOGGER,
  });
  link = startRelayLink({
    baseUrl: relay.baseUrl,
    credential: {
      deviceId: desktop.deviceId,
      deviceToken: desktop.deviceToken,
    },
    hello: {
      appVersion: '0.0.0',
      desktopName: 'E2E Mac',
      platform: 'macos',
      supportedContractVersions: [1],
    },
    handlers: connector.handlers,
    logger: SILENT_LOGGER,
    backoff: { baseMs: 50, maxMs: 200 },
  });
  connector.attachLink(link);
  await waitUntil(() => link?.state().status === 'ready');

  return {
    baseUrl: relay.baseUrl,
    desktopId: desktop.deviceId,
    phoneAuthorization: `Bearer ${phone.deviceId}.${phone.deviceToken}`,
  };
}

function phoneWsUrl(
  side: AgentSide,
  path: '/ws' | '/ws/asr',
): string {
  const wsBase = side.baseUrl.replace(/^http/, 'ws');
  return `${wsBase}${path}?desktopId=${encodeURIComponent(side.desktopId)}`;
}

describe('relay agent e2e（真实 relay 进程）', () => {
  it('手机经真实 relay 完成 protocol hello/ready（控制通道）', async () => {
    const side = await startAgentOverRelay();
    const phone = await connectPhone(phoneWsUrl(side, '/ws'), side.phoneAuthorization);
    const readyFrame = nextFrame(phone);
    phone.send(JSON.stringify(PHONE_HELLO));
    const ready = await readyFrame;
    expect(ready['type']).toBe('connection.ready');
    expect(ready['payload']).toMatchObject({
      desktopId: 'desk_e2e',
      handshakeId: 'hs_e2e',
      connectionEpoch: 1,
    });
  }, 20000);

  it('asr 通道未配置密钥时回传 ASR_NOT_CONFIGURED 错误事件', async () => {
    const side = await startAgentOverRelay();
    const asr = await connectPhone(
      phoneWsUrl(side, '/ws/asr'),
      side.phoneAuthorization,
    );
    const errorFrame = nextFrame(asr);
    asr.send(JSON.stringify(ASR_START));
    const event = await errorFrame;
    expect(event['type']).toBe('asr.error');
    expect(event['code']).toBe('ASR_NOT_CONFIGURED');
  }, 20000);
});