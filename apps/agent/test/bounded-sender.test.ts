import { ProtocolMessage } from '@claude-remote/protocol/types';
import { describe, expect, it, vi } from 'vitest';

import { BoundedSender } from '../src/transport/bounded-sender.js';

const message = (id: string, textSize: number = 0): ProtocolMessage => ({
  protocolVersion: 1,
  messageId: id,
  timestamp: 0,
  type: 'session.status',
  payload: { text: 'x'.repeat(textSize) },
});

describe('BoundedSender', () => {
  it('writes immediately when the socket accepts', () => {
    const written: string[] = [];
    const sender = new BoundedSender(() => undefined);
    sender.attach((data) => {
      written.push(data);
      return true;
    });

    expect(sender.send(message('msg_1'))).toBe('sent');
    expect(written).toHaveLength(1);
  });

  it('queues while the socket refuses and reports queued', () => {
    const sender = new BoundedSender(() => undefined);
    sender.attach(() => false);

    expect(sender.send(message('msg_1'))).toBe('queued');
  });

  it('drains queued messages once the socket accepts again', () => {
    const written: string[] = [];
    let accepting = false;
    const sender = new BoundedSender(() => undefined);
    sender.attach((data) => {
      if (!accepting) return false;
      written.push(data);
      return true;
    });
    sender.send(message('msg_1'));

    accepting = true;
    expect(sender.send(message('msg_2'))).toBe('sent');
    expect(written).toHaveLength(2);
  });

  it('asks for pressure and closes when the queue is still over budget', () => {
    const onPressure = vi.fn();
    const sender = new BoundedSender(onPressure, 1024 * 1024, 1);
    sender.attach(() => false);
    sender.send(message('msg_1'));

    expect(sender.send(message('msg_2'))).toBe('closed');
    expect(onPressure).toHaveBeenCalledTimes(1);
    expect(sender.send(message('msg_3'))).toBe('closed');
  });

  it('recovers when the pressure callback frees the socket', () => {
    let accepting = false;
    const written: string[] = [];
    const sender = new BoundedSender(() => {
      accepting = true;
    }, 1024 * 1024, 1);
    sender.attach((data) => {
      if (!accepting) return false;
      written.push(data);
      return true;
    });
    sender.send(message('msg_1'));

    expect(sender.send(message('msg_2'))).toBe('sent');
    expect(written).toHaveLength(2);
  });

  it('closes when the byte budget is exceeded', () => {
    const sender = new BoundedSender(() => undefined, 300, 1000);
    sender.attach(() => false);
    sender.send(message('msg_1', 150));

    expect(sender.send(message('msg_2', 150))).toBe('closed');
  });
});