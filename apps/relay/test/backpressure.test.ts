import { WebSocket } from 'ws';

import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMITS, RelayLimits } from '../src/limits.js';
import { DesktopLink } from '../src/routing/registry.js';
import { PhoneLink } from '../src/routing/phone-link.js';
import {
  spliceDesktopToPhone,
  splicePhoneToDesktop,
} from '../src/routing/splice.js';

class FakeSocket {
  readonly sent: Array<{ data: string | Buffer; binary?: boolean }> = [];
  readonly closed: Array<{ code: number; reason: string }> = [];
  bufferedAmount = 0;

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    this.sent.push({
      data,
      ...(options?.binary === undefined ? {} : { binary: options.binary }),
    });
    this.bufferedAmount += Buffer.byteLength(
      typeof data === 'string' ? data : data.toString('utf8'),
    );
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }
}

function phoneLink(socket: FakeSocket, kind: 'control' | 'asr' = 'control'): PhoneLink {
  return {
    channelId: 'ch_test',
    deviceId: 'dev_phone',
    accountId: 'acc_1',
    desktopId: 'dev_desktop',
    kind,
    socket: socket as unknown as WebSocket,
    pendingBytes: 0,
  };
}

function desktopLink(socket: FakeSocket): DesktopLink {
  return {
    desktopId: 'dev_desktop',
    accountId: 'acc_1',
    epoch: 1,
    socket: socket as unknown as WebSocket,
    channels: new Map(),
    send: (message) => {
      socket.send(JSON.stringify(message));
    },
  };
}

const SMALL_LIMITS: RelayLimits = {
  ...DEFAULT_LIMITS,
  channelBufferBytes: 500,
  desktopBufferBytes: 1000,
};

describe('背压（契约 §5.3）', () => {
  it('桌面总缓冲超 desktopBufferBytes → 当前通道 4003 且不转发', () => {
    const desktopSocket = new FakeSocket();
    desktopSocket.bufferedAmount = 1001;
    const phoneSocket = new FakeSocket();
    splicePhoneToDesktop(
      phoneLink(phoneSocket),
      desktopLink(desktopSocket),
      Buffer.from('x'),
      false,
      SMALL_LIMITS,
    );
    expect(desktopSocket.sent).toHaveLength(0);
    expect(phoneSocket.closed).toEqual([
      { code: 4003, reason: 'slow consumer' },
    ]);
  });

  it('桌面缓冲未清时通道累计 pendingBytes 超 channelBufferBytes → 4003', () => {
    const desktopSocket = new FakeSocket();
    desktopSocket.bufferedAmount = 10;
    const phoneSocket = new FakeSocket();
    const desktop = desktopLink(desktopSocket);
    const link = phoneLink(phoneSocket);

    splicePhoneToDesktop(link, desktop, Buffer.alloc(300, 120), false, SMALL_LIMITS);
    expect(phoneSocket.closed).toHaveLength(0);
    expect(link.pendingBytes).toBe(300);

    splicePhoneToDesktop(link, desktop, Buffer.alloc(300, 120), false, SMALL_LIMITS);
    expect(phoneSocket.closed).toEqual([
      { code: 4003, reason: 'slow consumer' },
    ]);
  });

  it('桌面缓冲归零后 pendingBytes 重置', () => {
    const desktopSocket = new FakeSocket();
    desktopSocket.bufferedAmount = 10;
    const phoneSocket = new FakeSocket();
    const desktop = desktopLink(desktopSocket);
    const link = phoneLink(phoneSocket);

    splicePhoneToDesktop(link, desktop, Buffer.alloc(300, 120), false, SMALL_LIMITS);
    expect(link.pendingBytes).toBe(300);

    desktopSocket.bufferedAmount = 0;
    splicePhoneToDesktop(link, desktop, Buffer.alloc(300, 120), false, SMALL_LIMITS);
    expect(link.pendingBytes).toBe(0);
    expect(phoneSocket.closed).toHaveLength(0);
  });

  it('下行：手机缓冲超 channelBufferBytes → 4003 且不发送', () => {
    const phoneSocket = new FakeSocket();
    phoneSocket.bufferedAmount = 501;
    spliceDesktopToPhone(
      phoneLink(phoneSocket),
      { channelId: 'ch_test', binary: false, data: 'hello' },
      SMALL_LIMITS,
    );
    expect(phoneSocket.sent).toHaveLength(0);
    expect(phoneSocket.closed).toEqual([
      { code: 4003, reason: 'slow consumer' },
    ]);
  });
});