import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  VirtualPhoneSocket,
  VirtualSocketTransport,
} from '../../src/relay/virtual-socket.js';

interface SentFrame {
  kind: 'text' | 'binary' | 'close';
  data: unknown;
}

function createTransport(): {
  frames: SentFrame[];
  transport: VirtualSocketTransport;
} {
  const frames: SentFrame[] = [];
  return {
    frames,
    transport: {
      sendText: (data) => frames.push({ kind: 'text', data }),
      sendBinary: (data) => frames.push({ kind: 'binary', data }),
      sendClose: (code, reason) =>
        frames.push({ kind: 'close', data: { code, reason } }),
    },
  };
}

describe('VirtualPhoneSocket', () => {
  it('receive 文本 → message 事件 isBinary=false；二进制 → Buffer + true', () => {
    const { transport } = createTransport();
    const socket = new VirtualPhoneSocket(transport);
    const seen: Array<{ data: string | Buffer; isBinary: boolean }> = [];
    socket.on('message', (data, isBinary) => {
      seen.push({ data: data as string | Buffer, isBinary: isBinary as boolean });
    });

    socket.receive('hello', false);
    const binary = Buffer.from([1, 2, 3]);
    socket.receive(binary, true);

    expect(seen).toEqual([
      { data: 'hello', isBinary: false },
      { data: binary, isBinary: true },
    ]);
  });

  it('ping 立即触发 pong（本地，不经过 relay）', async () => {
    const { transport, frames } = createTransport();
    const socket = new VirtualPhoneSocket(transport);
    let pongs = 0;
    socket.on('pong', () => {
      pongs += 1;
    });
    socket.ping();
    expect(pongs).toBe(0);
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(pongs).toBe(1);
    expect(frames).toHaveLength(0);
  });

  it('send 文本/二进制分别走 sendText/sendBinary；关闭后丢弃', () => {
    const { transport, frames } = createTransport();
    const socket = new VirtualPhoneSocket(transport);
    socket.send('text-frame');
    const binary = new Uint8Array([9, 8]);
    socket.send(binary);
    socket.close(1000, 'done');
    socket.send('after-close');

    expect(frames).toEqual([
      { kind: 'text', data: 'text-frame' },
      { kind: 'binary', data: binary },
      { kind: 'close', data: { code: 1000, reason: 'done' } },
    ]);
  });

  it('close(code) 外发一次 sendClose 并本地 close 一次；重复 close 不重复触发', () => {
    const { transport, frames } = createTransport();
    const socket = new VirtualPhoneSocket(transport);
    const closes: Array<{ code: number }> = [];
    socket.on('close', (code) => {
      closes.push({ code: code as number });
    });
    socket.close(4004, 'revoked');
    socket.close(4004, 'revoked');
    expect(frames.filter((frame) => frame.kind === 'close')).toHaveLength(1);
    expect(closes).toEqual([{ code: 4004 }]);
    expect(socket.readyState).toBe(3);
  });

  it('remoteClose 不外发、本地 close 事件携带 code', () => {
    const { transport, frames } = createTransport();
    const socket = new VirtualPhoneSocket(transport);
    const closes: number[] = [];
    socket.on('close', (code) => {
      closes.push(code as number);
    });
    socket.remoteClose(4010, 'desktop gone');
    expect(frames).toHaveLength(0);
    expect(closes).toEqual([4010]);
    expect(socket.readyState).toBe(3);
  });

  it('close() 无参使用默认 1000/空 reason', () => {
    const { transport, frames } = createTransport();
    const socket = new VirtualPhoneSocket(transport);
    socket.close();
    expect(frames).toEqual([
      { kind: 'close', data: { code: 1000, reason: '' } },
    ]);
  });

  it('terminate 本地 1006 且不发 sendClose', () => {
    const { transport, frames } = createTransport();
    const socket = new VirtualPhoneSocket(transport);
    const closes: number[] = [];
    socket.on('close', (code) => {
      closes.push(code as number);
    });
    socket.terminate();
    expect(frames).toHaveLength(0);
    expect(closes).toEqual([1006]);
  });
});