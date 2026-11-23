import { Buffer } from 'node:buffer';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentLogger } from '../../src/app/logger.js';
import {
  RelayLink,
  RelayLinkHandlers,
  startRelayLink,
} from '../../src/relay/link.js';
import { FakeRelay, startFakeRelay } from './fake-relay.js';

const SILENT_LOGGER: AgentLogger = { info() {}, warn() {} };

const HELLO = {
  appVersion: '0.0.0',
  desktopName: 'Test Mac',
  platform: 'macos',
  supportedContractVersions: [1],
};

const CREDENTIAL = { deviceId: 'dev_1', deviceToken: 'tok_1' };

const FAST_BACKOFF = { baseMs: 20, maxMs: 40 };

function recordingHandlers(): {
  handlers: RelayLinkHandlers;
  calls: Array<{ kind: string; input: Record<string, unknown> }>;
} {
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const handlers: RelayLinkHandlers = {
    onReady: (info) => calls.push({ kind: 'ready', input: { ...info } }),
    onChannelOpen: (input) => calls.push({ kind: 'open', input: { ...input } }),
    onChannelData: (input) =>
      calls.push({
        kind: 'data',
        input: {
          ...input,
          ...(input.binary
            ? { decoded: Buffer.from(input.data, 'base64').toString('hex') }
            : {}),
        },
      }),
    onChannelClose: (input) => calls.push({ kind: 'close', input: { ...input } }),
    onHttpRequest: (input) =>
      calls.push({
        kind: 'http',
        input: {
          channelId: undefined,
          requestId: input.requestId,
          deviceId: input.deviceId,
          method: input.method,
          path: input.path,
          contentType: input.contentType,
          bodyText: input.body.toString('utf8'),
        },
      }),
  };
  return { handlers, calls };
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

let link: RelayLink | null = null;
let relay: FakeRelay | null = null;

afterEach(async () => {
  link?.stop();
  link = null;
  await relay?.stop();
  relay = null;
});

describe('RelayLink 握手', () => {
  it('携带 Bearer 升级，发送合法 hello 并收到 ready 后 state=ready、epoch 记录', async () => {
    relay = await startFakeRelay({ epoch: 7 });
    const { handlers } = recordingHandlers();
    link = startRelayLink({
      baseUrl: relay.httpBase,
      credential: CREDENTIAL,
      hello: HELLO,
      handlers,
      logger: SILENT_LOGGER,
      backoff: FAST_BACKOFF,
    });
    await waitUntil(() => link?.state().status === 'ready');

    expect(relay.authorizations()[0]).toBe('Bearer dev_1.tok_1');
    const hello = relay
      .received()
      .find((message) => message['type'] === 'desktop.hello');
    const payload = hello?.['payload'] as Record<string, unknown>;
    expect(payload).toMatchObject(HELLO);
    expect(String(payload['handshakeId'])).toMatch(/^hs_/);
    expect(link.state()).toEqual({
      status: 'ready',
      lastEpoch: 7,
      lastError: null,
    });
  });
});

describe('RelayLink 入站分发', () => {
  it('channel.open/data/close 与 http.request 分发到 handlers', async () => {
    relay = await startFakeRelay();
    const { handlers, calls } = recordingHandlers();
    link = startRelayLink({
      baseUrl: relay.httpBase,
      credential: CREDENTIAL,
      hello: HELLO,
      handlers,
      logger: SILENT_LOGGER,
      backoff: FAST_BACKOFF,
    });
    await waitUntil(() => link?.state().status === 'ready');

    relay.send({
      type: 'channel.open',
      payload: {
        channelId: 'ch_1',
        kind: 'control',
        deviceId: 'dev_phone',
        appVersion: '1.0.0',
      },
    });
    relay.send({
      type: 'channel.data',
      payload: { channelId: 'ch_1', binary: false, data: 'hello-phone' },
    });
    relay.send({
      type: 'channel.data',
      payload: {
        channelId: 'ch_1',
        binary: true,
        data: Buffer.from([1, 2, 3]).toString('base64'),
      },
    });
    relay.send({
      type: 'channel.close',
      payload: { channelId: 'ch_1', code: 1000, reason: 'bye' },
    });
    relay.send({
      type: 'http.request',
      payload: {
        requestId: 'req_1',
        deviceId: 'dev_phone',
        method: 'POST',
        path: '/v1/attachments',
        contentType: 'application/json',
        bodyBase64: Buffer.from('{"a":1}').toString('base64'),
      },
    });
    await waitUntil(() => calls.filter((call) => call.kind !== 'ready').length >= 5);

    expect(calls.filter((call) => call.kind !== 'ready')).toEqual([
      {
        kind: 'open',
        input: {
          channelId: 'ch_1',
          kind: 'control',
          deviceId: 'dev_phone',
          appVersion: '1.0.0',
        },
      },
      {
        kind: 'data',
        input: { channelId: 'ch_1', data: 'hello-phone', binary: false },
      },
      {
        kind: 'data',
        input: {
          channelId: 'ch_1',
          data: 'AQID',
          binary: true,
          decoded: '010203',
        },
      },
      {
        kind: 'close',
        input: { channelId: 'ch_1', code: 1000, reason: 'bye' },
      },
      {
        kind: 'http',
        input: {
          channelId: undefined,
          requestId: 'req_1',
          deviceId: 'dev_phone',
          method: 'POST',
          path: '/v1/attachments',
          contentType: 'application/json',
          bodyText: '{"a":1}',
        },
      },
    ]);
  });
});

describe('RelayLink 出站编码', () => {
  it('channelData/channelClose/httpResponse 编码符合契约 §5.2/§5.4', async () => {
    relay = await startFakeRelay();
    const { handlers } = recordingHandlers();
    link = startRelayLink({
      baseUrl: relay.httpBase,
      credential: CREDENTIAL,
      hello: HELLO,
      handlers,
      logger: SILENT_LOGGER,
      backoff: FAST_BACKOFF,
    });
    await waitUntil(() => link?.state().status === 'ready');

    link.channelData('ch_1', 'text-frame');
    link.channelData('ch_1', new Uint8Array([1, 2, 3]));
    link.channelClose('ch_1', 4000, 'superseded');
    link.httpResponse('req_1', {
      status: 200,
      contentType: 'text/plain',
      body: Buffer.from('ok'),
    });
    await relay.waitForMessage((message) => message['type'] === 'http.response');

    const types = relay
      .received()
      .map((message) => message['type'])
      .filter((type) => type !== 'desktop.hello');
    expect(types).toEqual([
      'channel.data',
      'channel.data',
      'channel.close',
      'http.response',
    ]);
    const frames = relay
      .received()
      .filter((message) => message['type'] === 'channel.data');
    expect(frames[0]?.['payload']).toEqual({
      channelId: 'ch_1',
      binary: false,
      data: 'text-frame',
    });
    expect(frames[1]?.['payload']).toEqual({
      channelId: 'ch_1',
      binary: true,
      data: 'AQID',
    });
    const close = relay
      .received()
      .find((message) => message['type'] === 'channel.close');
    expect(close?.['payload']).toEqual({
      channelId: 'ch_1',
      code: 4000,
      reason: 'superseded',
    });
    const http = relay
      .received()
      .find((message) => message['type'] === 'http.response');
    expect(http?.['payload']).toEqual({
      requestId: 'req_1',
      status: 200,
      contentType: 'text/plain',
      bodyBase64: Buffer.from('ok').toString('base64'),
    });
  });
});

describe('RelayLink 重连与终止', () => {
  it('服务器断开后按退避重连并在 ready 后重置', async () => {
    relay = await startFakeRelay();
    const { handlers } = recordingHandlers();
    link = startRelayLink({
      baseUrl: relay.httpBase,
      credential: CREDENTIAL,
      hello: HELLO,
      handlers,
      logger: SILENT_LOGGER,
      backoff: FAST_BACKOFF,
    });
    await waitUntil(() => link?.state().status === 'ready');
    expect(relay.connectCount()).toBe(1);

    relay.closeSocket(1001, 'going away');
    await waitUntil(() => relay?.connectCount() === 2);
    await waitUntil(() => link?.state().status === 'ready');
    expect(link.state().status).toBe('ready');
  });

  it('close 4000/4002/4004 → 停止重连、state 记录 lastError', async () => {
    for (const code of [4000, 4002, 4004]) {
      relay = await startFakeRelay({
        onHello: (_hello, socket) => {
          socket.close(code, 'fatal');
        },
      });
      const { handlers } = recordingHandlers();
      link = startRelayLink({
        baseUrl: relay.httpBase,
        credential: CREDENTIAL,
        hello: HELLO,
        handlers,
        logger: SILENT_LOGGER,
        backoff: FAST_BACKOFF,
      });
      await waitUntil(() => link?.state().status === 'stopped');
      expect(link.state().lastError).toBe(String(code));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(relay.connectCount()).toBe(1);
      link.stop();
      link = null;
      await relay.stop();
      relay = null;
    }
  });

  it('畸形入站消息一律忽略且连接存活', async () => {
    relay = await startFakeRelay();
    const { handlers, calls } = recordingHandlers();
    link = startRelayLink({
      baseUrl: relay.httpBase,
      credential: CREDENTIAL,
      hello: HELLO,
      handlers,
      logger: SILENT_LOGGER,
      backoff: FAST_BACKOFF,
    });
    await waitUntil(() => link?.state().status === 'ready');

    const invalidFrames: unknown[] = [
      'not-json',
      42,
      { type: 'channel.open', payload: { channelId: 'x' } },
      { type: 'channel.open', payload: { channelId: 'x', kind: 'video', deviceId: 'd' } },
      { type: 'channel.data', payload: { channelId: 'x', binary: 'no', data: 'd' } },
      { type: 'channel.close', payload: { channelId: 'x', code: '1000', reason: 'r' } },
      {
        type: 'http.request',
        payload: {
          requestId: 'r',
          deviceId: 'd',
          method: 'GET',
          path: '/x',
          query: { bad: 1 },
        },
      },
      { type: 'relay.unknown', payload: {} },
      { payload: {} },
    ];
    for (const frame of invalidFrames) {
      relay.send(
        typeof frame === 'string'
          ? ({ raw: frame } as unknown as Record<string, unknown>)
          : (frame as Record<string, unknown>),
      );
    }
    // 直接塞一条非 JSON 原文，验证解析失败分支
    relay.currentSocket()?.send('not-json-frame');
    // 有效消息仍能分发
    relay.send({
      type: 'channel.data',
      payload: { channelId: 'ch_ok', binary: false, data: 'still-alive' },
    });
    await waitUntil(() =>
      calls.some(
        (call) =>
          call.kind === 'data' && call.input['data'] === 'still-alive',
      ),
    );
    expect(link.state().status).toBe('ready');
  });

  it('webSocketFactory 抛错时按退避重试而不崩溃', async () => {
    relay = await startFakeRelay();
    const { handlers } = recordingHandlers();
    let attempts = 0;
    link = startRelayLink({
      baseUrl: 'http://127.0.0.1:1',
      credential: CREDENTIAL,
      hello: HELLO,
      handlers,
      logger: SILENT_LOGGER,
      backoff: FAST_BACKOFF,
      webSocketFactory: () => {
        attempts += 1;
        throw new Error('factory boom');
      },
    });
    await waitUntil(() => attempts >= 3);
    expect(link.state().status).toBe('connecting');
  });

  it('升级被拒绝 401/403 → 停止重连并记录 HTTP_lastError', async () => {
    for (const statusCode of [401, 403]) {
      relay = await startFakeRelay({ upgradeStatus: statusCode });
      const { handlers } = recordingHandlers();
      link = startRelayLink({
        baseUrl: relay.httpBase,
        credential: CREDENTIAL,
        hello: HELLO,
        handlers,
        logger: SILENT_LOGGER,
        backoff: FAST_BACKOFF,
      });
      await waitUntil(() => link?.state().status === 'stopped');
      expect(link.state().lastError).toBe(`HTTP_${statusCode}`);
      const attempts = relay.upgradeCount();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(relay.upgradeCount()).toBe(attempts);
      link.stop();
      link = null;
      await relay.stop();
      relay = null;
    }
  });

  it('stop() 后不再重连', async () => {
    relay = await startFakeRelay();
    const { handlers } = recordingHandlers();
    link = startRelayLink({
      baseUrl: relay.httpBase,
      credential: CREDENTIAL,
      hello: HELLO,
      handlers,
      logger: SILENT_LOGGER,
      backoff: FAST_BACKOFF,
    });
    await waitUntil(() => link?.state().status === 'ready');
    link.stop();
    expect(link.state().status).toBe('stopped');
    relay.closeSocket(1001);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(relay.connectCount()).toBe(1);
  });
});