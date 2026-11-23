import { randomBytes } from 'node:crypto';

import { WebSocket } from 'ws';

import { afterEach, describe, expect, it } from 'vitest';

import {
  Credential,
  createAccount,
  desktopLogin,
  expectClose,
  login,
  nextPhoneFrame,
  nextPhoneText,
  openDesktop,
  openPhone,
  phoneLogin,
} from './helpers/clients.js';
import { RelayHandle, startRelay } from './helpers/harness.js';

const PASSWORD = 'pw-123456';
const ASR_FRAME_BYTES = 262144;

let handle: RelayHandle | null = null;

afterEach(async () => {
  await handle?.stop();
  handle = null;
});

interface Setup {
  relay: RelayHandle;
  desktop: Awaited<ReturnType<typeof openDesktop>>;
  phone: Credential;
  desktopId: string;
}

async function setup(): Promise<Setup> {
  handle = await startRelay();
  await createAccount(handle, 'alice', PASSWORD);
  const desktopCredential = await login(
    handle.baseUrl,
    desktopLogin('alice', PASSWORD),
  );
  const phone = await login(handle.baseUrl, phoneLogin('alice', PASSWORD));
  const desktop = await openDesktop(handle.baseUrl, desktopCredential);
  return { relay: handle, desktop, phone, desktopId: desktopCredential.deviceId };
}

describe('契约 §4.1/§5.2 语音通道', () => {
  it('二进制音频帧 base64 往返逐字节一致', async () => {
    const { relay, desktop, phone, desktopId } = await setup();
    const socket = await openPhone(relay.baseUrl, phone, desktopId, 'asr');
    const open = await desktop.nextMessage();
    expect(open).toMatchObject({
      type: 'channel.open',
      payload: { kind: 'asr', deviceId: phone.deviceId },
    });

    const pcm = randomBytes(3200);
    socket.send(pcm);
    const forwarded = await desktop.nextMessage();
    const payload = forwarded['payload'] as { binary: boolean; data: string };
    expect(payload.binary).toBe(true);
    expect(Buffer.from(payload.data, 'base64').equals(pcm)).toBe(true);

    const channelId = (open['payload'] as { channelId: string }).channelId;
    const back = randomBytes(1600);
    desktop.send({
      type: 'channel.data',
      payload: { channelId, binary: true, data: back.toString('base64') },
    });
    const received = await nextPhoneFrame(socket);
    expect(received.isBinary).toBe(true);
    expect(received.data.equals(back)).toBe(true);
    socket.close();
  });

  it('asr 文本控制帧原样拼接', async () => {
    const { relay, desktop, phone, desktopId } = await setup();
    const socket = await openPhone(relay.baseUrl, phone, desktopId, 'asr');
    const open = await desktop.nextMessage();

    const control = JSON.stringify({ type: 'asr.start', payload: { n: 1 } });
    socket.send(control);
    const forwarded = await desktop.nextMessage();
    expect(forwarded).toMatchObject({
      type: 'channel.data',
      payload: { binary: false, data: control },
    });

    const channelId = (open['payload'] as { channelId: string }).channelId;
    desktop.send({
      type: 'channel.data',
      payload: { channelId, binary: false, data: '{"type":"asr.partial"}' },
    });
    expect(await nextPhoneText(socket)).toBe('{"type":"asr.partial"}');
    socket.close();
  });

  it('恰好 256KiB 通过，256KiB+1 → 4003', async () => {
    const { relay, desktop, phone, desktopId } = await setup();
    const socket = await openPhone(relay.baseUrl, phone, desktopId, 'asr');
    await desktop.nextMessage();

    socket.send(randomBytes(ASR_FRAME_BYTES));
    const delivered = await desktop.nextMessage();
    expect(
      Buffer.from(
        (delivered['payload'] as { data: string }).data,
        'base64',
      ).length,
    ).toBe(ASR_FRAME_BYTES);

    const closed = expectClose(socket, 4003);
    socket.send(randomBytes(ASR_FRAME_BYTES + 1));
    await closed;
  });

  it('同一手机 control 与 asr 通道并行互不干扰', async () => {
    const { relay, desktop, phone, desktopId } = await setup();
    const control = await openPhone(relay.baseUrl, phone, desktopId, 'control');
    const asr = await openPhone(relay.baseUrl, phone, desktopId, 'asr');

    const opens: Array<Record<string, unknown>> = [
      await desktop.nextMessage(),
      await desktop.nextMessage(),
    ];
    const kinds = opens.map(
      (open) => (open['payload'] as { kind: string }).kind,
    );
    expect(kinds.sort()).toEqual(['asr', 'control']);
    const channelIds = opens.map(
      (open) => (open['payload'] as { channelId: string }).channelId,
    );
    expect(new Set(channelIds).size).toBe(2);

    control.send('hello-control');
    asr.send(Buffer.from([1, 2, 3]));
    const first = await desktop.nextMessage();
    const second = await desktop.nextMessage();
    const texts = [first, second].map((message) => {
      const payload = message['payload'] as { data: string; binary: boolean };
      return payload.binary
        ? Buffer.from(payload.data, 'base64').toString('hex')
        : payload.data;
    });
    expect(texts.sort()).toEqual(['010203', 'hello-control']);

    expect(control.readyState).toBe(WebSocket.OPEN);
    expect(asr.readyState).toBe(WebSocket.OPEN);
    control.close();
    asr.close();
  });
});