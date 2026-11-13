import { describe, expect, it } from 'vitest';

import {
  AsrClientEvent,
  AsrError,
  AsrProvider,
  AsrProviderEvent,
  AsrProviderHandle,
  AsrProviderStart,
} from '../../src/asr/asr-protocol.js';
import { AsrStreamManager } from '../../src/asr/asr-stream-manager.js';

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
  starts = 0;
  writes: Uint8Array[] = [];
  finalizeCalls = 0;
  cancelCalls: string[] = [];
  readonly events = new FakeEvents();
  startImpl: () => Promise<AsrProviderHandle> = async () => ({
    asrStreamId: 'asr_1',
    events: this.events,
  });

  start(input: AsrProviderStart): Promise<AsrProviderHandle> {
    this.starts += 1;
    return this.startImpl().then((handle) => ({
      asrStreamId: input.asrStreamId,
      events: handle.events,
    }));
  }

  write(_handle: AsrProviderHandle, audio: Uint8Array): void {
    this.writes.push(audio);
    if (this.writeError !== null) throw this.writeError;
  }

  writeError: AsrError | null = null;

  finalize(): void {
    this.finalizeCalls += 1;
  }

  cancel(_handle: AsrProviderHandle, reason: string): void {
    this.cancelCalls.push(reason);
  }
}

interface Harness {
  provider: FakeProvider;
  manager: AsrStreamManager;
  events: AsrClientEvent[];
}

function harness(options: {
  connectTimeoutMs?: number;
  finalTimeoutMs?: number;
  maxRecordingMs?: number;
} = {}): Harness {
  const provider = new FakeProvider();
  const events: AsrClientEvent[] = [];
  const manager = new AsrStreamManager({
    provider,
    onEvent: (event) => events.push(event),
    connectTimeoutMs: options.connectTimeoutMs ?? 200,
    finalTimeoutMs: options.finalTimeoutMs ?? 200,
    maxRecordingMs: options.maxRecordingMs ?? 10_000,
  });
  return { provider, manager, events };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function expectError(promise: Promise<unknown>, code: string) {
  let captured: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(AsrError);
  expect((captured as AsrError).code).toBe(code);
}

function types(events: AsrClientEvent[]): string[] {
  return events.map((event) => event.type);
}

describe('AsrStreamManager', () => {
  it('allows only one active stream and emits asr.started', async () => {
    const { provider, manager, events } = harness();
    await manager.start({ deviceId: 'device_1', asrStreamId: 'asr_1' });
    expect(manager.activeStreamId).toBe('asr_1');
    expect(types(events)).toEqual(['asr.started']);
    await expectError(
      manager.start({ deviceId: 'device_1', asrStreamId: 'asr_2' }),
      'ASR_BUSY',
    );
    expect(provider.starts).toBe(1);
  });

  it('fails with ASR_CONNECTION_FAILED when start never resolves', async () => {
    const { provider, manager, events } = harness({ connectTimeoutMs: 10 });
    provider.startImpl = () => new Promise<AsrProviderHandle>(() => {});
    await expectError(
      manager.start({ deviceId: 'device_1', asrStreamId: 'asr_1' }),
      'ASR_CONNECTION_FAILED',
    );
    expect(types(events)).toEqual(['asr.error', 'asr.closed']);
    expect(manager.activeStreamId).toBeNull();
  });

  it('propagates provider handshake errors with their safe code', async () => {
    const { provider, manager, events } = harness();
    provider.startImpl = () =>
      Promise.reject(
        new AsrError(
          'ASR_PROVIDER_UNAUTHENTICATED',
          false,
          'ASR_PROVIDER_UNAUTHENTICATED',
        ),
      );
    await expectError(
      manager.start({ deviceId: 'device_1', asrStreamId: 'asr_1' }),
      'ASR_PROVIDER_UNAUTHENTICATED',
    );
    expect(types(events)).toEqual(['asr.error', 'asr.closed']);
  });

  it('times out when finalize produces no final', async () => {
    const { provider, manager, events } = harness({ finalTimeoutMs: 10 });
    await manager.start({ deviceId: 'device_1', asrStreamId: 'asr_1' });
    manager.write('asr_1', new Uint8Array([1, 2]));
    manager.finish('asr_1');
    await delay(30);
    expect(provider.finalizeCalls).toBe(1);
    expect(types(events)).toEqual(['asr.started', 'asr.error', 'asr.closed']);
    expect(provider.cancelCalls).toEqual(['ASR_FINAL_TIMEOUT']);
    expect(manager.activeStreamId).toBeNull();
  });

  it('auto-finalizes at the maximum recording duration', async () => {
    const { provider, manager } = harness({ maxRecordingMs: 10 });
    await manager.start({ deviceId: 'device_1', asrStreamId: 'asr_1' });
    await delay(30);
    expect(provider.finalizeCalls).toBe(1);
  });

  it('ignores writes after finish', async () => {
    const { provider, manager } = harness();
    await manager.start({ deviceId: 'device_1', asrStreamId: 'asr_1' });
    manager.finish('asr_1');
    manager.write('asr_1', new Uint8Array([1, 2]));
    expect(provider.writes).toEqual([]);
  });

  it('forwards final once and closes the stream', async () => {
    const { provider, manager, events } = harness();
    await manager.start({ deviceId: 'device_1', asrStreamId: 'asr_1' });
    manager.finish('asr_1');
    provider.events.push({ type: 'final', text: '你好。' });
    await delay(10);
    expect(types(events)).toEqual(['asr.started', 'asr.final', 'asr.closed']);
    expect(manager.activeStreamId).toBeNull();
    expect(provider.cancelCalls).toEqual(['completed']);
  });

  it('turns a provider error into a terminal safe error', async () => {
    const { provider, manager, events } = harness();
    await manager.start({ deviceId: 'device_1', asrStreamId: 'asr_1' });
    provider.events.push({
      type: 'error',
      code: 'ASR_PROVIDER_ERROR',
      retryable: true,
    });
    await delay(10);
    expect(types(events)).toEqual(['asr.started', 'asr.error', 'asr.closed']);
  });

  it('cancels idempotently and drops late events', async () => {
    const { provider, manager, events } = harness();
    await manager.start({ deviceId: 'device_1', asrStreamId: 'asr_1' });
    manager.cancel('asr_1', 'user');
    manager.cancel('asr_1', 'user');
    provider.events.push({ type: 'final', text: '迟到' });
    await delay(10);
    expect(types(events)).toEqual([
      'asr.started',
      'asr.cancelled',
      'asr.closed',
    ]);
    expect(provider.cancelCalls).toEqual(['user']);
    expect(manager.activeStreamId).toBeNull();
  });

  it('cancelAll only affects the active stream', async () => {
    const { provider, manager, events } = harness();
    await manager.start({ deviceId: 'device_1', asrStreamId: 'asr_1' });
    manager.cancelAll('app_background');
    expect(types(events)).toEqual([
      'asr.started',
      'asr.cancelled',
      'asr.closed',
    ]);
    expect(provider.cancelCalls).toEqual(['app_background']);
    manager.cancelAll('again');
    expect(provider.cancelCalls).toHaveLength(1);
  });

  it('fails the stream when a write is rejected by the provider', async () => {
    const { provider, manager, events } = harness();
    await manager.start({ deviceId: 'device_1', asrStreamId: 'asr_1' });
    provider.writeError = new AsrError(
      'ASR_BACKPRESSURE',
      true,
      'ASR_BACKPRESSURE',
    );
    manager.write('asr_1', new Uint8Array([1, 2]));
    await delay(10);
    expect(types(events)).toEqual(['asr.started', 'asr.error', 'asr.closed']);
    expect(manager.activeStreamId).toBeNull();
  });
});