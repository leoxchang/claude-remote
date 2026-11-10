import { EventEmitter } from 'node:events';

import { ProtocolMessage } from '@claude-remote/protocol/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { DeviceRecord } from '../src/domain/types.js';
import { ConnectionManager } from '../src/transport/connection-manager.js';

const DEVICE: DeviceRecord = {
  deviceId: 'device_01',
  deviceName: 'iPhone',
  tokenHash: 'hash',
  createdAt: '2026-11-10T00:00:00.000Z',
  revokedAt: null,
};

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  pings = 0;
  closeCalls: Array<{ code: number; reason: string }> = [];
  terminated = false;

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pings += 1;
  }

  close(code?: number, reason?: string): void {
    this.readyState = WebSocket.CLOSED;
    this.closeCalls.push({ code: code ?? 1000, reason: reason ?? '' });
    this.emit('close');
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  receive(message: unknown): void {
    this.emit('message', JSON.stringify(message));
  }

  pong(): void {
    this.emit('pong');
  }
}

const DEVICE_B: DeviceRecord = {
  ...DEVICE,
  deviceId: 'device_02',
  deviceName: 'iPad',
};

const hello = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocolVersion: 1,
  messageId: 'msg_hello',
  timestamp: 0,
  type: 'connection.hello',
  payload: {
    supportedProtocolVersions: [1],
    appVersion: '0.1.0',
    deviceId: DEVICE.deviceId,
    capabilities: ['text'],
    handshakeId: 'handshake_1',
    ...overrides,
  },
});

const event = (id: string): ProtocolMessage => ({
  protocolVersion: 1,
  messageId: id,
  timestamp: 0,
  type: 'session.status',
  payload: {},
});

function manager(): ConnectionManager {
  return new ConnectionManager({
    desktopId: 'desktop_test',
    versions: { agent: '0.0.0', sdk: '0.3.319', runtime: '2.1.319' },
    capabilities: ['text'],
  });
}

function connect(
  instance: ConnectionManager,
  device: DeviceRecord = DEVICE,
): Promise<FakeSocket> {
  const socket = new FakeSocket();
  return instance
    .accept(socket as unknown as WebSocket, device)
    .then(() => socket);
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('ConnectionManager handshake', () => {
  it('closes when the first message is not connection.hello', async () => {
    const instance = manager();
    const socket = await connect(instance);

    socket.receive({ type: 'prompt.send', payload: {} });

    expect(socket.closeCalls).toHaveLength(1);
  });

  it('closes after ten seconds without a hello', async () => {
    vi.useFakeTimers();
    const instance = manager();
    const socket = await connect(instance);

    vi.advanceTimersByTime(10_000);

    expect(socket.closeCalls).toHaveLength(1);
  });

  it('answers hello with a ready that echoes the handshake id and epoch', async () => {
    const instance = manager();
    const socket = await connect(instance);

    socket.receive(hello());

    const ready = JSON.parse(socket.sent[0] ?? '{}') as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(ready.type).toBe('connection.ready');
    expect(ready.payload).toMatchObject({
      handshakeId: 'handshake_1',
      connectionEpoch: 1,
      desktopId: 'desktop_test',
    });
  });

  it('rejects an incompatible protocol version', async () => {
    const instance = manager();
    const socket = await connect(instance);

    socket.receive(hello({ supportedProtocolVersions: [2] }));

    const rejection = JSON.parse(socket.sent[0] ?? '{}') as {
      type: string;
      payload: { error?: { code?: string } };
    };
    expect(rejection.payload.error?.code).toBe('VERSION_INCOMPATIBLE');
    expect(socket.closeCalls).toHaveLength(1);
  });
});

describe('ConnectionManager connections', () => {
  it('publishes events only to ready connections', async () => {
    const instance = manager();
    const pending = await connect(instance, DEVICE_B);
    const ready = await connect(instance);
    ready.receive(hello());

    instance.publish(event('msg_1'));

    expect(pending.sent).toHaveLength(0);
    expect(ready.sent).toHaveLength(2);
    expect(JSON.parse(ready.sent[1] ?? '{}')).toMatchObject({
      type: 'session.status',
      messageId: 'msg_1',
    });
  });

  it('closes the previous socket when a new epoch connects', async () => {
    const instance = manager();
    const first = await connect(instance);
    first.receive(hello());

    const second = await connect(instance);

    expect(first.closeCalls).toHaveLength(1);
    expect(instance.currentEpoch(DEVICE.deviceId)).toBe(2);
    expect(second.closeCalls).toHaveLength(0);
  });

  it('keeps serving the run after a revoke by not publishing to the revoked socket', async () => {
    const instance = manager();
    const socket = await connect(instance);
    socket.receive(hello());

    instance.revoke(DEVICE.deviceId);
    instance.publish(event('msg_after_revoke'));

    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.sent).toHaveLength(1);
  });
});

describe('ConnectionManager heartbeat', () => {
  it('pings every fifteen seconds and terminates after 45 seconds without pong', async () => {
    vi.useFakeTimers();
    const instance = manager();
    const socket = await connect(instance);
    socket.receive(hello());

    vi.advanceTimersByTime(15_000);
    expect(socket.pings).toBe(1);

    vi.advanceTimersByTime(45_000);
    expect(socket.terminated).toBe(true);
  });

  it('keeps the connection while pongs arrive', async () => {
    vi.useFakeTimers();
    const instance = manager();
    const socket = await connect(instance);
    socket.receive(hello());

    for (let tick = 0; tick < 4; tick += 1) {
      vi.advanceTimersByTime(15_000);
      socket.pong();
    }

    expect(socket.terminated).toBe(false);
  });
});