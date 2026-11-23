import { WebSocket } from 'ws';

import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMITS } from '../src/limits.js';
import { DesktopLink } from '../src/routing/registry.js';
import { PhoneLink } from '../src/routing/phone-link.js';
import {
  spliceDesktopToPhone,
  splicePhoneToDesktop,
} from '../src/routing/splice.js';

class FakeSocket {
  readonly sent: Array<{ data: string | Buffer; binary?: boolean }> = [];
  readonly closed: Array<{ code: number; reason: string }> = [];

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    this.sent.push({ data, ...(options?.binary === undefined ? {} : { binary: options.binary }) });
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }
}

function phoneLink(
  socket: FakeSocket,
  kind: 'control' | 'asr' = 'control',
): PhoneLink {
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

function desktopLink(): { link: DesktopLink; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const link: DesktopLink = {
    desktopId: 'dev_desktop',
    accountId: 'acc_1',
    epoch: 1,
    socket: new FakeSocket() as unknown as WebSocket,
    channels: new Map(),
    send: (message) => {
      sent.push(message as unknown as Record<string, unknown>);
    },
  };
  return { link, sent };
}

describe('splicePhoneToDesktop', () => {
  it('control 通道收到二进制帧 → close 4003，桌面无转发', () => {
    const socket = new FakeSocket();
    const { link: desktop, sent } = desktopLink();
    splicePhoneToDesktop(
      phoneLink(socket),
      desktop,
      Buffer.from([1, 2, 3]),
      true,
      DEFAULT_LIMITS,
    );
    expect(socket.closed).toEqual([
      { code: 4003, reason: 'frame too large' },
    ]);
    expect(sent).toHaveLength(0);
  });

  it('文本帧原样封装为 channel.data，二进制帧 base64 封装', () => {
    const socket = new FakeSocket();
    const { link: desktop, sent } = desktopLink();
    splicePhoneToDesktop(
      phoneLink(socket),
      desktop,
      Buffer.from('{"type":"x"}', 'utf8'),
      false,
      DEFAULT_LIMITS,
    );
    expect(sent[0]).toEqual({
      type: 'channel.data',
      payload: { channelId: 'ch_test', binary: false, data: '{"type":"x"}' },
    });

    const binary = Buffer.from([0, 1, 2, 250, 251]);
    splicePhoneToDesktop(
      phoneLink(socket, 'asr'),
      desktop,
      binary,
      true,
      DEFAULT_LIMITS,
    );
    const payload = sent[1]?.['payload'] as { data: string; binary: boolean };
    expect(payload.binary).toBe(true);
    expect(Buffer.from(payload.data, 'base64').equals(binary)).toBe(true);
  });

  it('control 帧按 UTF-8 字节数判定上限：65536 通过，65537 关闭 4003（Review Focus 3）', () => {
    const socket = new FakeSocket();
    const { link: desktop, sent } = desktopLink();
    splicePhoneToDesktop(
      phoneLink(socket),
      desktop,
      Buffer.from('a'.repeat(65536), 'utf8'),
      false,
      DEFAULT_LIMITS,
    );
    expect(sent).toHaveLength(1);
    expect(socket.closed).toHaveLength(0);

    splicePhoneToDesktop(
      phoneLink(socket),
      desktop,
      Buffer.from('a'.repeat(65537), 'utf8'),
      false,
      DEFAULT_LIMITS,
    );
    expect(socket.closed).toEqual([{ code: 4003, reason: 'frame too large' }]);
  });
});

describe('spliceDesktopToPhone', () => {
  it('文本原样送达', () => {
    const socket = new FakeSocket();
    spliceDesktopToPhone(phoneLink(socket), {
      channelId: 'ch_test',
      binary: false,
      data: 'hello-back',
    });
    expect(socket.sent[0]).toEqual({ data: 'hello-back' });
  });

  it('二进制 base64 解码逐字节还原', () => {
    const socket = new FakeSocket();
    const payload = Buffer.from([9, 8, 7, 0, 255]);
    spliceDesktopToPhone(phoneLink(socket, 'asr'), {
      channelId: 'ch_test',
      binary: true,
      data: payload.toString('base64'),
    });
    const sent = socket.sent[0];
    expect(sent?.binary).toBe(true);
    expect(Buffer.isBuffer(sent?.data)).toBe(true);
    expect((sent?.data as Buffer).equals(payload)).toBe(true);
  });
});