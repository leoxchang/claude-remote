import { Buffer } from 'node:buffer';

import { FastifyInstance, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  AsrClientEvent,
} from '../../src/asr/asr-protocol.js';
import {
  AsrGateway,
  AsrStreamControl,
} from '../../src/asr/asr-gateway.js';

class FakeSocket {
  readonly text: string[] = [];
  readonly binary: Uint8Array[] = [];
  closed = false;
  throwOnSend = false;
  private readonly listeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  send(data: string | Uint8Array): void {
    if (this.throwOnSend) throw new Error('socket closed');
    if (typeof data === 'string') this.text.push(data);
    else this.binary.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  receive(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }

  receiveBinary(bytes: Uint8Array): void {
    this.emit('message', Buffer.from(bytes), true);
  }

  messages(): Array<Record<string, unknown>> {
    return this.text.map(
      (entry) => JSON.parse(entry) as Record<string, unknown>,
    );
  }
}

class FakeApp {
  path: string | null = null;
  handler: ((socket: FakeSocket, request: unknown) => void) | null = null;

  get(
    path: string,
    _options: { websocket: boolean },
    handler: (socket: FakeSocket, request: unknown) => void,
  ): void {
    this.path = path;
    this.handler = handler;
  }
}

class FakeManager implements AsrStreamControl {
  starts: string[] = [];
  writes: Uint8Array[] = [];
  lastWriteStreamId: string | null = null;
  finishes: string[] = [];
  cancels: string[] = [];
  startImpl: ((input: { asrStreamId: string }) => Promise<void>) | null =
    null;
  private sink: ((event: AsrClientEvent) => void) | null = null;

  setEventSink(listener: (event: AsrClientEvent) => void): void {
    this.sink = listener;
  }

  start(input: { deviceId: string; asrStreamId: string }): Promise<void> {
    this.starts.push(input.asrStreamId);
    if (this.startImpl !== null) return this.startImpl(input);
    this.sink?.({ type: 'asr.started', asrStreamId: input.asrStreamId });
    return Promise.resolve();
  }

  write(asrStreamId: string, audio: Uint8Array): void {
    this.writes.push(audio);
    this.lastWriteStreamId = asrStreamId;
  }

  finish(asrStreamId: string): void {
    this.finishes.push(asrStreamId);
  }

  cancel(asrStreamId: string, reason: string): void {
    this.cancels.push(`${asrStreamId}:${reason}`);
  }

  cancelAll(reason: string): void {
    this.cancels.push(`all:${reason}`);
  }

  emit(event: AsrClientEvent): void {
    this.sink?.(event);
  }
}

interface Harness {
  gateway: AsrGateway;
  app: FakeApp;
  socket: FakeSocket;
  manager: FakeManager;
  connect(options?: {
    deviceId?: string | null;
    now?: () => number;
  }): FakeSocket;
}

interface HarnessOptions {
  clock?: () => number;
  authenticateRejects?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const manager = new FakeManager();
  const app = new FakeApp();
  const authenticate = (
    request: FastifyRequest,
  ): Promise<{ deviceId: string } | null> => {
    if (options.authenticateRejects === true) {
      return Promise.reject(new Error('auth unavailable'));
    }
    const deviceId = (request as unknown as { deviceId?: string | null })
      .deviceId;
    return Promise.resolve(
      deviceId === null || deviceId === undefined
        ? null
        : { deviceId },
    );
  };
  const gateway = new AsrGateway({
    authenticate,
    manager,
    now: options.clock ?? (() => 0),
  });
  gateway.attach(app as unknown as FastifyInstance);
  const connect = (options: {
    deviceId?: string | null;
    now?: () => number;
  } = {}): FakeSocket => {
    const socket = new FakeSocket();
    const request = {
      deviceId:
        options.deviceId === undefined ? 'device_1' : options.deviceId,
    };
    if (options.now !== undefined) {
      const clock = options.now;
      clock();
    }
    app.handler?.(socket, request);
    return socket;
  };
  return { gateway, app, manager, socket: new FakeSocket(), connect };
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

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function types(socket: FakeSocket): unknown[] {
  return socket.messages().map((message) => message['type']);
}

describe('AsrGateway', () => {
  it('registers /ws/asr and closes unauthenticated upgrades', async () => {
    const { app, connect } = harness();
    expect(app.path).toBe('/ws/asr');
    const socket = connect({ deviceId: null });
    await settle();
    expect(socket.closed).toBe(true);
    expect(socket.text).toEqual([]);
  });

  it('requires a valid asr.start as the first message', async () => {
    const { connect } = harness();
    const socket = connect();
    socket.receive({ ...START, type: 'asr.finish' });
    await settle();
    expect(types(socket)).toEqual(['asr.error', 'asr.closed']);
    expect(socket.messages()[0]?.['code']).toBe('INVALID_MESSAGE');
    expect(socket.closed).toBe(true);
  });

  it('rejects extra session fields and oversize control payloads', async () => {
    const { connect } = harness();
    const first = connect();
    first.receive({ ...START, sessionId: 'session_1' });
    await settle();
    expect(first.messages()[0]?.['code']).toBe('INVALID_MESSAGE');

    const second = connect();
    second.receive({ ...START, messageId: 'x'.repeat(5000) });
    await settle();
    expect(second.messages()[0]?.['code']).toBe('INVALID_MESSAGE');
  });

  it('starts a stream, forwards audio, and delivers final then closed', async () => {
    const { connect, manager } = harness();
    const socket = connect();
    socket.receive(START);
    await settle();
    socket.receiveBinary(new Uint8Array([1, 2, 3, 4]));
    socket.receive(FINISH);
    manager.emit({ type: 'asr.final', asrStreamId: 'asr_1', sequence: 1, text: '你好。' });
    manager.emit({ type: 'asr.closed', asrStreamId: 'asr_1', reason: 'completed' });
    await settle();
    expect(manager.starts).toEqual(['asr_1']);
    expect(manager.writes).toHaveLength(1);
    expect(manager.finishes).toEqual(['asr_1']);
    expect(types(socket)).toEqual(['asr.started', 'asr.final', 'asr.closed']);
    expect(socket.closed).toBe(true);
  });

  it('rejects a second start on the same connection', async () => {
    const { connect } = harness();
    const socket = connect();
    socket.receive(START);
    await settle();
    socket.receive({ ...START, messageId: 'msg_second', asrStreamId: 'asr_2' });
    await settle();
    expect(socket.messages().map((m) => m['code'])).toContain(
      'ASR_STREAM_CONFLICT',
    );
    expect(types(socket).at(-1)).toBe('asr.closed');
  });

  it('ignores a replayed messageId instead of creating a new stream', async () => {
    const { connect, manager } = harness();
    const socket = connect();
    socket.receive(START);
    await settle();
    socket.receive(START);
    await settle();
    expect(manager.starts).toEqual(['asr_1']);
  });

  it('rejects odd, empty and oversized binary frames', async () => {
    const cases = [
      new Uint8Array([1]),
      new Uint8Array([]),
      new Uint8Array(6402),
    ];
    for (const bytes of cases) {
      const { connect, manager } = harness();
      const socket = connect();
      socket.receive(START);
      await settle();
      socket.receiveBinary(bytes);
      await settle();
      expect(
        socket
          .messages()
          .some((message) => message['code'] === 'ASR_INVALID_AUDIO'),
      ).toBe(true);
      expect(manager.cancels).toEqual(['asr_1:ASR_INVALID_AUDIO']);
      expect(socket.closed).toBe(true);
    }
  });

  it('treats finish while connecting as cancel', async () => {
    const { connect, manager } = harness();
    manager.startImpl = () => new Promise<void>(() => {});
    const socket = connect();
    socket.receive(START);
    await settle();
    socket.receive(FINISH);
    await settle();
    expect(manager.finishes).toEqual([]);
    expect(manager.cancels).toEqual(['asr_1:user']);
    expect(socket.closed).toBe(true);
  });

  it('cancels immediately on asr.cancel', async () => {
    const { connect, manager } = harness();
    const socket = connect();
    socket.receive(START);
    await settle();
    socket.receive({ ...FINISH, type: 'asr.cancel', messageId: 'msg_cancel' });
    await settle();
    expect(manager.cancels).toEqual(['asr_1:user']);
    expect(socket.closed).toBe(true);
  });

  it('rate limits the eleventh start per device within one minute', async () => {
    const { connect, manager } = harness();
    for (let index = 0; index < 10; index += 1) {
      const socket = connect();
      socket.receive({
        ...START,
        messageId: `msg_${index}`,
        asrStreamId: `asr_${index}`,
      });
      await settle();
      socket.close();
    }
    const eleventh = connect();
    eleventh.receive({
      ...START,
      messageId: 'msg_eleventh',
      asrStreamId: 'asr_11',
    });
    await settle();
    expect(eleventh.messages()[0]?.['code']).toBe('ASR_RATE_LIMITED');
    expect(manager.starts).toHaveLength(10);
  });

  it('keeps only the latest partial and backpressures on overflow', async () => {
    const { connect, manager } = harness();
    const socket = connect();
    socket.receive(START);
    await settle();
    for (let index = 1; index <= 4; index += 1) {
      manager.emit({
        type: 'asr.partial',
        asrStreamId: 'asr_1',
        sequence: index,
        text: `片段${index}`,
      });
    }
    await settle();
    const partials = socket
      .messages()
      .filter((message) => message['type'] === 'asr.partial');
    expect(partials).toHaveLength(1);
    expect(partials[0]?.['text']).toBe('片段4');

    for (let index = 0; index < 5; index += 1) {
      manager.emit({
        type: 'asr.cancelled',
        asrStreamId: 'asr_1',
        reason: `r${index}`,
      });
    }
    await settle();
    expect(
      socket.messages().some((message) => message['code'] === 'ASR_BACKPRESSURE'),
    ).toBe(true);
    expect(manager.cancels).toContain('asr_1:ASR_BACKPRESSURE');
  });

  it('cancels the stream when the socket closes without finish', async () => {
    const { connect, manager } = harness();
    const socket = connect();
    socket.receive(START);
    await settle();
    socket.receiveBinary(new Uint8Array([1, 2]));
    socket.close();
    await settle();
    expect(manager.cancels).toContain('asr_1:socket_closed');
  });

  it('closeAll cancels the manager stream', () => {
    const { gateway, manager } = harness();
    gateway.closeAll('agent_shutdown');
    expect(manager.cancels).toContain('all:agent_shutdown');
  });

  it('sends safe errors without provider payloads', async () => {
    const { connect, manager } = harness();
    const socket = connect();
    socket.receive(START);
    await settle();
    manager.emit({
      type: 'asr.error',
      asrStreamId: 'asr_1',
      code: 'ASR_PROVIDER_ERROR',
      retryable: true,
      safeMessage: 'ASR_PROVIDER_ERROR',
    });
    await settle();
    const error = socket.messages().find((m) => m['type'] === 'asr.error');
    expect(Object.keys(error ?? {}).sort()).toEqual([
      'asrStreamId',
      'code',
      'retryable',
      'safeMessage',
      'type',
    ]);
  });

  it('ignores binary before start and after a terminal event', async () => {
    const { connect, manager } = harness();
    const socket = connect();
    socket.receiveBinary(new Uint8Array([1, 2]));
    await settle();
    expect(socket.text).toEqual([]);
    socket.receive(START);
    await settle();
    socket.receive({ ...FINISH, type: 'asr.cancel', messageId: 'msg_cancel' });
    await settle();
    const before = socket.messages().length;
    socket.receiveBinary(new Uint8Array([1, 2]));
    await settle();
    expect(socket.messages().length).toBe(before);
    expect(manager.writes).toHaveLength(0);
  });

  it('closes the connection when authentication throws', async () => {
    const { connect } = harness({ authenticateRejects: true });
    const socket = connect();
    await settle();
    expect(socket.closed).toBe(true);
    expect(socket.text).toEqual([]);
  });

  it('accepts audio delivered as a buffer array', async () => {
    const { connect, manager } = harness();
    const socket = connect();
    socket.receive(START);
    await settle();
    socket.emit('message', [Buffer.from([1, 2])], true);
    await settle();
    expect(manager.writes).toHaveLength(1);
  });

  it('rejects control frames that are not text', async () => {
    const { connect } = harness();
    const socket = connect();
    socket.emit('message', 42, false);
    await settle();
    expect(socket.messages()[0]?.['code']).toBe('INVALID_MESSAGE');
  });

  it('survives a socket send failure without throwing', async () => {
    const { connect, manager } = harness();
    const socket = connect();
    socket.throwOnSend = true;
    socket.receive(START);
    await settle();
    expect(manager.starts).toEqual(['asr_1']);
  });

  it('allows a new start after the one-minute rate window', async () => {
    let now = 0;
    const { connect, manager } = harness({ clock: () => now });
    for (let index = 0; index < 10; index += 1) {
      const socket = connect();
      socket.receive({
        ...START,
        messageId: `msg_${index}`,
        asrStreamId: `asr_${index}`,
      });
      await settle();
      socket.close();
    }
    now = 61_000;
    const next = connect();
    next.receive({ ...START, messageId: 'msg_next', asrStreamId: 'asr_next' });
    await settle();
    expect(manager.starts).toHaveLength(11);
  });

  it('closeAll without an active stream still delegates to the manager', () => {
    const { gateway, manager } = harness();
    gateway.closeAll('agent_shutdown');
    expect(manager.cancels).toEqual(['all:agent_shutdown']);
  });
});