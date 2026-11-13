import { describe, expect, it } from 'vitest';

import websocket from '@fastify/websocket';
import Fastify, { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

import {
  AsrProvider,
  AsrProviderEvent,
  AsrProviderHandle,
  AsrProviderStart,
} from '../../src/asr/asr-protocol.js';
import { AsrConfig } from '../../src/asr/asr-config.js';
import { createAsrRuntime, AsrRuntime } from '../../src/asr/asr-runtime.js';

const AUTHORIZATION = 'Bearer device_1.token';

class FakeEvents implements AsyncIterable<AsrProviderEvent> {
  private readonly queue: AsrProviderEvent[] = [];
  private waiters: Array<() => void> = [];

  push(event: AsrProviderEvent): void {
    this.queue.push(event);
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AsrProviderEvent> {
    while (true) {
      const event = this.queue.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

class FakeProvider implements AsrProvider {
  readonly events = new FakeEvents();
  readonly writes: Uint8Array[] = [];
  readonly cancellations: string[] = [];

  start(input: AsrProviderStart): Promise<AsrProviderHandle> {
    return Promise.resolve({
      asrStreamId: input.asrStreamId,
      events: this.events,
    });
  }

  write(_handle: AsrProviderHandle, audio: Uint8Array): void {
    this.writes.push(audio);
  }

  finalize(): void {
    this.events.push({ type: 'final', text: '你好，世界。' });
  }

  cancel(_handle: AsrProviderHandle, reason: string): void {
    this.cancellations.push(reason);
  }
}

class Client {
  readonly messages: Array<Record<string, unknown>> = [];

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const raw = String(data);
      try {
        this.messages.push(
          JSON.parse(raw) as Record<string, unknown>,
        );
      } catch {
        this.messages.push({ type: raw });
      }
    });
  }

  opened(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  sendBinary(bytes: Uint8Array): void {
    this.socket.send(bytes);
  }

  async waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs = 3000,
  ): Promise<Record<string, unknown>> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = this.messages.find(predicate);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    throw new Error(
      `timed out; saw ${JSON.stringify(this.messages.map((m) => m['type']))}`,
    );
  }

  close(): void {
    this.socket.close();
  }
}

interface Harness {
  app: FastifyInstance;
  runtime: AsrRuntime;
  provider: FakeProvider;
  url: string;
  connect(): Promise<Client>;
}

async function harness(options: {
  env?: NodeJS.ProcessEnv;
  withMainSocket?: boolean;
} = {}): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  app.get('/health', async () => ({ ok: true }));
  if (options.withMainSocket === true) {
    app.get('/ws', { websocket: true }, (socket) => {
      socket.send('main-ready');
    });
  }
  const provider = new FakeProvider();
  const runtime = createAsrRuntime({
    app,
    env: options.env ?? { DOUBAO_ASR_API_KEY: 'key_1' },
    authenticate: async (request) =>
      request.headers.authorization === AUTHORIZATION
        ? { deviceId: 'device_1' }
        : null,
    providerFactory: (_config: AsrConfig) => provider,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('app is not listening');
  }
  const url = `ws://127.0.0.1:${address.port}`;
  return {
    app,
    runtime,
    provider,
    url,
    async connect(): Promise<Client> {
      const socket = new WebSocket(`${url}/ws/asr`, {
        headers: { Authorization: AUTHORIZATION },
      });
      const client = new Client(socket);
      await client.opened();
      return client;
    },
  };
}

const START = {
  protocolVersion: 1,
  messageId: 'msg_start',
  timestamp: 1762432800000,
  type: 'asr.start',
  asrStreamId: 'asr_1',
  payload: {
    audio: { format: 'pcm-s16le', sampleRate: 16000, channels: 1 },
  },
};

const FINISH = {
  protocolVersion: 1,
  messageId: 'msg_finish',
  timestamp: 1762432801000,
  type: 'asr.finish',
  asrStreamId: 'asr_1',
  payload: {},
};

function isType(type: string) {
  return (message: Record<string, unknown>): boolean =>
    message['type'] === type;
}

async function dispose(created: Harness): Promise<void> {
  created.runtime.close('test_cleanup');
  await created.app.close();
}

describe('S05 agent ASR flow', () => {
  it('streams start → audio → finish → final → closed', async () => {
    const created = await harness();
    try {
      const client = await created.connect();
      client.send(START);
      await client.waitFor(isType('asr.started'));
      client.sendBinary(new Uint8Array([1, 2, 3, 4]));
      client.send(FINISH);
      const final = await client.waitFor(isType('asr.final'));
      expect(final['text']).toBe('你好，世界。');
      await client.waitFor(isType('asr.closed'));
      expect(created.provider.writes).toHaveLength(1);
      client.close();
    } finally {
      await dispose(created);
    }
  });

  it('cancels immediately and never produces a final', async () => {
    const created = await harness();
    try {
      const client = await created.connect();
      client.send(START);
      await client.waitFor(isType('asr.started'));
      client.send({ ...FINISH, type: 'asr.cancel', messageId: 'msg_cancel' });
      await client.waitFor(isType('asr.cancelled'));
      await client.waitFor(isType('asr.closed'));
      expect(created.provider.cancellations).toContain('user');
      client.close();
    } finally {
      await dispose(created);
    }
  });

  it('maps a provider error to a safe terminal error', async () => {
    const created = await harness();
    try {
      const client = await created.connect();
      client.send(START);
      await client.waitFor(isType('asr.started'));
      created.provider.events.push({
        type: 'error',
        code: 'ASR_PROVIDER_OVERLOADED',
        retryable: true,
      });
      const error = await client.waitFor(isType('asr.error'));
      expect(error['code']).toBe('ASR_PROVIDER_OVERLOADED');
      await client.waitFor(isType('asr.closed'));
      client.close();
    } finally {
      await dispose(created);
    }
  });

  it('keeps the agent healthy when the API key is missing', async () => {
    const created = await harness({ env: {} });
    try {
      expect(created.runtime.status).toBe('not_configured');
      const response = await fetch(`${created.url.replace('ws:', 'http:')}/health`);
      expect(response.status).toBe(200);
      const client = await created.connect();
      client.send(START);
      const error = await client.waitFor(isType('asr.error'));
      expect(error['code']).toBe('ASR_NOT_CONFIGURED');
      await client.waitFor(isType('asr.closed'));
      client.close();
    } finally {
      await dispose(created);
    }
  });

  it('treats an invalid resource id as not configured', async () => {
    const created = await harness({
      env: {
        DOUBAO_ASR_API_KEY: 'key_1',
        DOUBAO_ASR_RESOURCE_ID: 'legacy-model',
      },
    });
    try {
      expect(created.runtime.status).toBe('not_configured');
    } finally {
      await dispose(created);
    }
  });

  it('builds the real provider when configured without a factory', async () => {
    const app = Fastify({ logger: false });
    await app.register(websocket);
    const runtime = createAsrRuntime({
      app,
      env: { DOUBAO_ASR_API_KEY: 'key_1' },
      authenticate: async () => ({ deviceId: 'device_1' }),
    });
    expect(runtime.status).toBe('configured');
    runtime.close('test_cleanup');
    await app.close();
  });

  it('closes the audio stream on device revoke', async () => {
    const created = await harness();
    try {
      const client = await created.connect();
      client.send(START);
      await client.waitFor(isType('asr.started'));
      created.runtime.close('device_revoked');
      await client.waitFor(isType('asr.cancelled'));
      const closed = await client.waitFor(isType('asr.closed'));
      expect(closed['reason']).toBe('device_revoked');
      client.close();
    } finally {
      await dispose(created);
    }
  });

  it('keeps audio independent from the main control socket', async () => {
    const created = await harness({ withMainSocket: true });
    try {
      const main = new Client(
        new WebSocket(`${created.url}/ws`, {
          headers: { Authorization: AUTHORIZATION },
        }),
      );
      await main.opened();
      await main.waitFor((message) => message['type'] === 'main-ready');
      main.close();

      const client = await created.connect();
      client.send(START);
      await client.waitFor(isType('asr.started'));
      client.sendBinary(new Uint8Array([1, 2]));
      client.send(FINISH);
      await client.waitFor(isType('asr.final'));
      client.close();
    } finally {
      await dispose(created);
    }
  });
});