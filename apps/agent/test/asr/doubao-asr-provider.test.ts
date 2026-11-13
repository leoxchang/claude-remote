import { describe, expect, it } from 'vitest';

import {
  AsrError,
  AsrProviderEvent,
  AsrProviderHandle,
} from '../../src/asr/asr-protocol.js';
import {
  DOUBAO_ASR_ENDPOINT,
  AsrConfig,
} from '../../src/asr/asr-config.js';
import {
  DoubaoAsrProvider,
  WebSocketLike,
} from '../../src/asr/doubao/doubao-asr-provider.js';

const CONFIG: AsrConfig = {
  provider: 'doubao',
  apiKey: 'key_1',
  resourceId: 'volc.seedasr.sauc.duration',
};

class FakeSocket implements WebSocketLike {
  readonly sent: Array<Uint8Array | string> = [];
  bufferedAmount = 0;
  closed = false;
  closeCode: number | null = null;

  private readonly listeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  send(data: Uint8Array | string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code ?? 1000;
    this.emit('close', code ?? 1000, reason ?? '');
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  open(): void {
    this.emit('open');
  }

  deliver(frame: Uint8Array): void {
    this.emit('message', Buffer.from(frame));
  }

  fail(statusCode: number): void {
    this.emit('error', Object.assign(new Error('socket failed'), { statusCode }));
  }
}

interface Harness {
  provider: DoubaoAsrProvider;
  socket: FakeSocket;
  opened: { url: string; headers: Record<string, string> }[];
}

function harness(connectTimeoutMs = 50): Harness {
  const opened: { url: string; headers: Record<string, string> }[] = [];
  const socket = new FakeSocket();
  const provider = new DoubaoAsrProvider({
    config: CONFIG,
    openSocket: (url, headers) => {
      opened.push({ url, headers });
      return socket;
    },
    requestId: () => 'req_test_1',
    connectTimeoutMs,
  });
  return { provider, socket, opened };
}

interface ServerFrameInput {
  messageType: number;
  flags?: number;
  json: unknown;
}

function serverFrame(input: ServerFrameInput): Uint8Array {
  const payload = Buffer.from(JSON.stringify(input.json), 'utf8');
  const body = Buffer.alloc(8 + payload.length);
  body.writeInt32BE(1, 0);
  body.writeUint32BE(payload.length, 4);
  payload.copy(body, 8);
  return Buffer.concat([
    Buffer.from([
      0x11,
      (input.messageType << 4) | (input.flags ?? 0b0001),
      0x00,
      0x00,
    ]),
    body,
  ]);
}

function response(
  text: string,
  options: { last?: boolean; definite?: boolean } = {},
): Uint8Array {
  return serverFrame({
    messageType: 0b1001,
    json: {
      code: 0,
      result: {
        text,
        utterances: [
          {
            text,
            definite: options.definite === true,
            is_last_package: options.last === true,
          },
        ],
      },
    },
  });
}

function errorFrame(code: number): Uint8Array {
  return serverFrame({
    messageType: 0b1111,
    json: { code, message: 'provider failed' },
  });
}

async function startReady(
  created: Harness,
  asrStreamId = 'asr_1',
): Promise<AsrProviderHandle> {
  const pending = created.provider.start({
    asrStreamId,
    audio: { format: 'pcm-s16le', sampleRate: 16000, channels: 1 },
  });
  created.socket.open();
  return pending;
}

async function nextEvents(
  handle: AsrProviderHandle,
  count: number,
): Promise<AsrProviderEvent[]> {
  const events: AsrProviderEvent[] = [];
  const iterator = handle.events[Symbol.asyncIterator]();
  while (events.length < count) {
    const next = await iterator.next();
    if (next.done === true) break;
    events.push(next.value);
  }
  return events;
}

async function expectAsrError(promise: Promise<unknown>, code: string) {
  let captured: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(AsrError);
  expect((captured as AsrError).code).toBe(code);
}

describe('DoubaoAsrProvider', () => {
  it('rejects when the socket does not open within the connect timeout', async () => {
    const created = harness(10);
    await expectAsrError(
      created.provider.start({
        asrStreamId: 'asr_1',
        audio: { format: 'pcm-s16le', sampleRate: 16000, channels: 1 },
      }),
      'ASR_CONNECTION_FAILED',
    );
  });

  it('maps a non-2xx handshake to ASR_PROVIDER_UNAUTHENTICATED', async () => {
    const created = harness();
    const pending = created.provider.start({
      asrStreamId: 'asr_1',
      audio: { format: 'pcm-s16le', sampleRate: 16000, channels: 1 },
    });
    created.socket.fail(401);
    await expectAsrError(pending, 'ASR_PROVIDER_UNAUTHENTICATED');
  });

  it('opens the fixed endpoint with only the three documented headers', async () => {
    const created = harness();
    await startReady(created);
    expect(created.opened).toHaveLength(1);
    expect(created.opened[0]?.url).toBe(DOUBAO_ASR_ENDPOINT);
    expect(Object.keys(created.opened[0]?.headers ?? {}).sort()).toEqual([
      'X-Api-Key',
      'X-Api-Request-Id',
      'X-Api-Resource-Id',
    ]);
    expect(created.opened[0]?.headers['X-Api-Request-Id']).toBe('req_test_1');
  });

  it('maps provider responses to partial, definite and final events in order', async () => {
    const created = harness();
    const handle = await startReady(created);
    const collected = nextEvents(handle, 3);
    created.socket.deliver(response('你好'));
    created.socket.deliver(response('你好，', { definite: true }));
    created.socket.deliver(response('你好，世界。', { last: true }));
    const events = await collected;
    expect(events.map((event) => event.type)).toEqual([
      'partial',
      'utteranceDefinite',
      'final',
    ]);
    expect(events[2]).toEqual({ type: 'final', text: '你好，世界。' });
  });

  it('maps provider errors to a safe error event', async () => {
    const created = harness();
    const handle = await startReady(created);
    const collected = nextEvents(handle, 2);
    created.socket.deliver(errorFrame(45000001));
    const events = await collected;
    expect(events[0]).toEqual({
      type: 'error',
      code: 'ASR_PROVIDER_ERROR',
      retryable: true,
    });
    expect(events[1]).toEqual({ type: 'closed', reason: 'provider_error' });
  });

  it('applies backpressure above 256 KiB and terminates the stream', async () => {
    const created = harness();
    const handle = await startReady(created);
    created.socket.bufferedAmount = 256 * 1024 + 1;
    const collected = nextEvents(handle, 2);
    created.provider.write(handle, new Uint8Array([1, 2]));
    const events = await collected;
    expect(events[0]).toEqual({
      type: 'error',
      code: 'ASR_BACKPRESSURE',
      retryable: true,
    });
    expect(events[1]).toEqual({ type: 'closed', reason: 'backpressure' });
    expect(created.socket.closed).toBe(true);
  });

  it('sends exactly one last-audio frame holding back the final packet', async () => {
    const created = harness();
    const handle = await startReady(created);
    created.provider.write(handle, new Uint8Array([1, 2, 3, 4]));
    created.provider.write(handle, new Uint8Array([5, 6, 7, 8]));
    created.provider.finalize(handle);
    created.provider.finalize(handle);
    const audioFrames = created.socket.sent
      .filter((entry): entry is Uint8Array => entry instanceof Uint8Array)
      .slice(1);
    expect(audioFrames).toHaveLength(2);
    const last = audioFrames[1];
    expect(last).toBeDefined();
    expect(last?.[1] ?? 0).toBe((0b0010 << 4) | 0b0011);
    expect([...(last ?? new Uint8Array()).subarray(12)]).toEqual([
      5, 6, 7, 8,
    ]);
  });

  it('cancels idempotently and drops late events', async () => {
    const created = harness();
    const handle = await startReady(created);
    created.provider.cancel(handle, 'user');
    created.provider.cancel(handle, 'user');
    expect(created.socket.closed).toBe(true);
    const events = await nextEvents(handle, 1);
    expect(events).toEqual([]);
  });

  it('reports a socket close once', async () => {
    const created = harness();
    const handle = await startReady(created);
    const collected = nextEvents(handle, 1);
    created.socket.close(1006, 'network');
    expect(await collected).toEqual([
      { type: 'closed', reason: 'socket_closed' },
    ]);
  });
});