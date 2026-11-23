import { Buffer } from 'node:buffer';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentLogger } from '../../src/app/logger.js';
import {
  createRelayConnector,
  RelayHttpDispatch,
  startRelayFromConfig,
} from '../../src/relay/connector.js';
import { RelayLink, startRelayLink } from '../../src/relay/link.js';
import { createTrustedDevices } from '../../src/relay/trusted-devices.js';
import { AgentConfigV5 } from '../../src/config/config-v5.js';
import { ConnectionManager } from '../../src/transport/connection-manager.js';
import { FakeRelay, startFakeRelay } from './fake-relay.js';

const SILENT_LOGGER: AgentLogger = { info() {}, warn() {} };
const FAST_BACKOFF = { baseMs: 20, maxMs: 40 };
const CREDENTIAL = { deviceId: 'dev_desktop', deviceToken: 'tok' };
const HELLO = {
  appVersion: '0.0.0',
  desktopName: 'Wiring Mac',
  platform: 'macos',
  supportedContractVersions: [1],
};

const NOT_FOUND_DISPATCH: RelayHttpDispatch = () => ({
  status: 404,
  contentType: 'application/json',
  body: Buffer.from('{"error":{"code":"ROUTE_NOT_FOUND"}}'),
});

function phoneHello(messageId: string): Record<string, unknown> {
  return {
    protocolVersion: 1,
    messageId,
    timestamp: Date.now(),
    type: 'connection.hello',
    payload: {
      supportedProtocolVersions: [1],
      appVersion: '1.0.0',
      deviceId: 'dev_phone',
      capabilities: [],
      handshakeId: `hs_${messageId}`,
    },
  };
}

function channelDataOf(message: Record<string, unknown>): string | null {
  if (message['type'] !== 'channel.data') return null;
  const payload = message['payload'] as { data?: unknown; binary?: unknown };
  if (payload.binary !== false || typeof payload.data !== 'string') return null;
  return payload.data;
}

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

interface Harness {
  relay: FakeRelay;
  link: RelayLink;
  manager: ConnectionManager;
  relayDevices: ReturnType<typeof createTrustedDevices>;
  readyMessages(): Array<Record<string, unknown>>;
}

let harness: Harness | null = null;

afterEach(async () => {
  harness?.link.stop();
  await harness?.relay.stop();
  harness = null;
});

async function setup(): Promise<Harness> {
  const relay = await startFakeRelay();
  const manager = new ConnectionManager({
    desktopId: 'desk_test',
    agentInstanceId: 'agent_test',
    versions: { agent: '0.0.0', sdk: 'x', runtime: 'x' },
    capabilities: ['text'],
  });
  const relayDevices = createTrustedDevices(() => false);
  const connector = createRelayConnector({
    connections: manager,
    relayDevices,
    asrAccept: () => {},
    httpDispatch: NOT_FOUND_DISPATCH,
    logger: SILENT_LOGGER,
  });
  const link = startRelayLink({
    baseUrl: relay.httpBase,
    credential: CREDENTIAL,
    hello: HELLO,
    handlers: connector.handlers,
    logger: SILENT_LOGGER,
    backoff: FAST_BACKOFF,
  });
  connector.attachLink(link);
  await waitUntil(() => link.state().status === 'ready');

  const readyMessages = (): Array<Record<string, unknown>> => {
    const found: Array<Record<string, unknown>> = [];
    for (const message of relay.received()) {
      const text = channelDataOf(message);
      if (text === null) continue;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed['type'] === 'connection.ready') found.push(parsed);
      } catch {
        // 非 JSON 帧忽略
      }
    }
    return found;
  };

  harness = { relay, link, manager, relayDevices, readyMessages };
  return harness;
}

describe('connector 控制通道（fake relay + 真实 ConnectionManager）', () => {
  it('channel.open(control) → protocol v1 hello/ready 往返', async () => {
    const { relay, readyMessages } = await setup();
    relay.send({
      type: 'channel.open',
      payload: {
        channelId: 'ch_1',
        kind: 'control',
        deviceId: 'dev_phone',
        appVersion: '1.0.0',
      },
    });
    // 等待 channel.open 抵达桌面端（由 relay 记录上行不需要）；直接下发 hello
    relay.send({
      type: 'channel.data',
      payload: {
        channelId: 'ch_1',
        binary: false,
        data: JSON.stringify(phoneHello('msg_hello')),
      },
    });
    await waitUntil(() => readyMessages().length >= 1);
    const ready = readyMessages()[0];
    expect(ready?.['payload']).toMatchObject({
      desktopId: 'desk_test',
      handshakeId: 'hs_msg_hello',
      connectionEpoch: 1,
    });
  });

  it('channel.close → 虚拟连接关闭、信任设备回收；同 deviceId 重开不残留旧状态', async () => {
    const { relay, relayDevices, readyMessages } = await setup();
    relay.send({
      type: 'channel.open',
      payload: { channelId: 'ch_1', kind: 'control', deviceId: 'dev_phone' },
    });
    relay.send({
      type: 'channel.data',
      payload: {
        channelId: 'ch_1',
        binary: false,
        data: JSON.stringify(phoneHello('msg_1')),
      },
    });
    await waitUntil(() => readyMessages().length >= 1);
    expect(relayDevices.isActive('dev_phone')).toBe(true);

    relay.send({
      type: 'channel.close',
      payload: { channelId: 'ch_1', code: 1000, reason: 'phone closed' },
    });
    await waitUntil(() => !relayDevices.isActive('dev_phone'));

    relay.send({
      type: 'channel.open',
      payload: { channelId: 'ch_2', kind: 'control', deviceId: 'dev_phone' },
    });
    relay.send({
      type: 'channel.data',
      payload: {
        channelId: 'ch_2',
        binary: false,
        data: JSON.stringify(phoneHello('msg_2')),
      },
    });
    await waitUntil(() => readyMessages().length >= 2);
    const second = readyMessages()[1];
    expect(second?.['payload']).toMatchObject({
      desktopId: 'desk_test',
      handshakeId: 'hs_msg_2',
      connectionEpoch: 2,
    });
  });

  it('relay 断链 → 虚拟连接关闭并回收信任设备；重连后新通道正常', async () => {
    const { relay, relayDevices, link, readyMessages } = await setup();
    relay.send({
      type: 'channel.open',
      payload: { channelId: 'ch_1', kind: 'control', deviceId: 'dev_phone' },
    });
    relay.send({
      type: 'channel.data',
      payload: {
        channelId: 'ch_1',
        binary: false,
        data: JSON.stringify(phoneHello('msg_1')),
      },
    });
    await waitUntil(() => readyMessages().length >= 1);
    expect(relayDevices.isActive('dev_phone')).toBe(true);

    relay.closeSocket(1001, 'going away');
    await waitUntil(() => !relayDevices.isActive('dev_phone'));
    await waitUntil(() => relay.connectCount() === 2);
    await waitUntil(() => link.state().status === 'ready');

    relay.send({
      type: 'channel.open',
      payload: { channelId: 'ch_9', kind: 'control', deviceId: 'dev_phone' },
    });
    relay.send({
      type: 'channel.data',
      payload: {
        channelId: 'ch_9',
        binary: false,
        data: JSON.stringify(phoneHello('msg_9')),
      },
    });
    await waitUntil(() => readyMessages().length >= 2);
    expect(relayDevices.isActive('dev_phone')).toBe(true);
  });
});

describe('startRelayFromConfig', () => {
  it('config.relay 缺省时返回 null 且无连接副作用', () => {
    const manager = new ConnectionManager({
      desktopId: 'desk_test',
      agentInstanceId: 'agent_test',
      versions: { agent: '0.0.0', sdk: 'x', runtime: 'x' },
      capabilities: [],
    });
    const config = {
      version: 5,
      desktopId: 'desk_test',
      database: { file: 'agent.sqlite3' },
      listen: { host: '127.0.0.1', port: 8787 },
      tailscale: { baseUrl: 'https://mac.example.ts.net' },
    } as AgentConfigV5;
    const session = startRelayFromConfig({
      config,
      connections: manager,
      relayDevices: createTrustedDevices(() => false),
      asrAccept: () => {},
      httpDispatch: NOT_FOUND_DISPATCH,
      logger: SILENT_LOGGER,
    });
    expect(session).toBeNull();
  });
});