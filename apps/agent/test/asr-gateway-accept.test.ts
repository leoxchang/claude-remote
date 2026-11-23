import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  AsrGateway,
  AsrStreamControl,
  GatewaySocket,
} from '../src/asr/asr-gateway.js';
import { AsrClientEvent } from '../src/asr/asr-protocol.js';

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

class FakeSocket {
  readonly text: string[] = [];
  closed = false;
  private readonly listeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.text.push(data);
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

  messages(): Array<Record<string, unknown>> {
    return this.text.map(
      (entry) => JSON.parse(entry) as Record<string, unknown>,
    );
  }
}

class FakeManager implements AsrStreamControl {
  readonly launches: Array<{ deviceId: string; asrStreamId: string }> = [];
  private sink: ((event: AsrClientEvent) => void) | null = null;

  setEventSink(listener: (event: AsrClientEvent) => void): void {
    this.sink = listener;
  }

  start(input: { deviceId: string; asrStreamId: string }): Promise<void> {
    this.launches.push(input);
    this.sink?.({ type: 'asr.started', asrStreamId: input.asrStreamId });
    return Promise.resolve();
  }

  write(): void {}

  finish(): void {}

  cancel(): void {}

  cancelAll(): void {}
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function harness(): {
  gateway: AsrGateway;
  manager: FakeManager;
  socket: FakeSocket;
} {
  const manager = new FakeManager();
  const gateway = new AsrGateway({
    authenticate: async () => null,
    manager,
  });
  const socket = new FakeSocket();
  gateway.acceptAuthenticated(
    socket as unknown as GatewaySocket,
    'dev_phone',
  );
  return { gateway, manager, socket };
}

describe('AsrGateway.acceptAuthenticated', () => {
  it('接收 asr 控制消息并把 deviceId 传给 manager.start', async () => {
    const { manager, socket } = harness();
    socket.receive(START);
    await settle();
    expect(manager.launches).toEqual([
      { deviceId: 'dev_phone', asrStreamId: 'asr_1' },
    ]);
    expect(
      socket
        .messages()
        .map((message) => message['type']),
    ).toContain('asr.started');
  });

  it('同一连接第二个 start → ASR_STREAM_CONFLICT 错误事件', async () => {
    const { socket } = harness();
    socket.receive(START);
    await settle();
    socket.receive({ ...START, messageId: 'msg_start_2' });
    await settle();
    const messages = socket.messages();
    expect(messages.map((message) => message['type'])).toEqual([
      'asr.started',
      'asr.error',
      'asr.closed',
    ]);
    expect(messages[1]?.['code']).toBe('ASR_STREAM_CONFLICT');
  });
});