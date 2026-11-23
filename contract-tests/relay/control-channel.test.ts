import { WebSocket } from 'ws';

import { afterEach, describe, expect, it } from 'vitest';

import {
  attemptPhone,
  Credential,
  createAccount,
  DesktopClient,
  desktopLogin,
  expectClose,
  login,
  nextPhoneText,
  openDesktop,
  openPhone,
  phoneLogin,
} from './helpers/clients.js';
import { RelayHandle, startRelay } from './helpers/harness.js';

const PASSWORD = 'pw-123456';
const CONTROL_FRAME_BYTES = 65536;

let handle: RelayHandle | null = null;

afterEach(async () => {
  await handle?.stop();
  handle = null;
});

interface Bootstrap {
  relay: RelayHandle;
  desktopCredential: Credential;
  phone: Credential;
}

interface Setup extends Bootstrap {
  desktop: DesktopClient;
}

async function bootstrap(): Promise<Bootstrap> {
  handle = await startRelay();
  await createAccount(handle, 'alice', PASSWORD);
  const desktopCredential = await login(
    handle.baseUrl,
    desktopLogin('alice', PASSWORD),
  );
  const phone = await login(handle.baseUrl, phoneLogin('alice', PASSWORD));
  return { relay: handle, desktopCredential, phone };
}

async function setup(): Promise<Setup> {
  const base = await bootstrap();
  const desktop = await openDesktop(base.relay.baseUrl, base.desktopCredential);
  return { ...base, desktop };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('契约 §4/§5.2 控制通道', () => {
  it('control 帧双向原样拼接且保序', async () => {
    const { relay, desktop, phone, desktopCredential } = await setup();
    const socket = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );

    const open = await desktop.nextMessage();
    expect(open).toMatchObject({
      type: 'channel.open',
      payload: { kind: 'control', deviceId: phone.deviceId },
    });

    const frames = Array.from({ length: 50 }, (_, index) =>
      JSON.stringify({ type: 'connection.hello', payload: { n: index } }),
    );
    for (const frame of frames) socket.send(frame);
    for (const frame of frames) {
      const message = await desktop.nextMessage();
      expect(message).toMatchObject({
        type: 'channel.data',
        payload: { binary: false, data: frame },
      });
    }

    const channelId = (open['payload'] as { channelId: string }).channelId;
    desktop.send({
      type: 'channel.data',
      payload: { channelId, binary: false, data: 'hello-back' },
    });
    expect(await nextPhoneText(socket)).toBe('hello-back');
    socket.close();
  });

  it('跨账号 desktopId 升级返回 404（Review Focus 2）', async () => {
    const { relay, desktopCredential } = await bootstrap();
    await createAccount(relay, 'bob', PASSWORD);
    const bobPhone = await login(relay.baseUrl, phoneLogin('bob', PASSWORD));
    const attempt = await attemptPhone(
      relay.baseUrl,
      bobPhone,
      desktopCredential.deviceId,
      'control',
    );
    expect(attempt).toEqual({ ok: false, status: 404 });
  });

  it('目标离线 503 DESKTOP_OFFLINE；缺 desktopId 400', async () => {
    const { relay, desktopCredential, phone } = await bootstrap();
    const offline = await attemptPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    expect(offline).toEqual({ ok: false, status: 503 });

    const missing = await attemptPhone(relay.baseUrl, phone, '', 'control');
    expect(missing).toEqual({ ok: false, status: 400 });
  });

  it('同设备同种类新连接取代旧连接 4000；asr 与 control 并存互不影响', async () => {
    const { relay, phone, desktopCredential } = await setup();
    const control = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    const asr = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'asr',
    );

    const controlClosed = expectClose(control, 4000);
    const secondControl = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    await controlClosed;
    await sleep(100);
    expect(asr.readyState).toBe(WebSocket.OPEN);
    secondControl.close();
    asr.close();
  });

  it('桌面断开 → 手机 4010；同一设备重连后手机可重连（Review Focus 4）', async () => {
    const { relay, desktop, phone, desktopCredential } = await setup();
    const socket = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    const firstOpen = await desktop.nextMessage();
    const firstChannelId = (firstOpen['payload'] as { channelId: string })
      .channelId;
    expect(firstChannelId).toMatch(/^ch_/);

    const phoneClosed = expectClose(socket, 4010);
    desktop.close();
    await phoneClosed;

    const renewed = await openDesktop(relay.baseUrl, desktopCredential);
    expect(renewed.epoch).toBeGreaterThan(desktop.epoch);
    const reconnect = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    const secondOpen = await renewed.nextMessage();
    const secondChannelId = (secondOpen['payload'] as { channelId: string })
      .channelId;
    expect(secondChannelId).toMatch(/^ch_/);
    expect(secondChannelId).not.toBe(firstChannelId);
    reconnect.close();
    renewed.close();
  });

  it('恰好 64KiB 文本帧通过，64KiB+1 → 手机连接 4003（Review Focus 3）', async () => {
    const { relay, desktop, phone, desktopCredential } = await setup();
    const socket = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    await desktop.nextMessage();

    socket.send('a'.repeat(CONTROL_FRAME_BYTES));
    const delivered = await desktop.nextMessage();
    expect(
      (delivered['payload'] as { data: string }).data.length,
    ).toBe(CONTROL_FRAME_BYTES);

    const closed = expectClose(socket, 4003);
    socket.send('a'.repeat(CONTROL_FRAME_BYTES + 1));
    await closed;
  });

  it('手机断开 → 桌面收到 channel.close 且 channelId 作废', async () => {
    const { relay, desktop, phone, desktopCredential } = await setup();
    const socket = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    const open = await desktop.nextMessage();
    const channelId = (open['payload'] as { channelId: string }).channelId;

    const closeNotice = desktop.nextMessage();
    socket.close(1000);
    expect(await closeNotice).toMatchObject({
      type: 'channel.close',
      payload: { channelId },
    });

    desktop.send({
      type: 'channel.data',
      payload: { channelId, binary: false, data: 'late' },
    });
    await sleep(100);
    expect(desktop.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('契约 §5.1 代次隔离（Review Focus 4）', () => {
  it('桌面被取代时挂载手机立即 4010，旧代次无法向新通道注入数据', async () => {
    const { relay, desktop, phone, desktopCredential } = await setup();
    const control = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    await desktop.nextMessage();

    // 旧桌面暂停读：关闭握手被延迟，取代后的清理不得依赖旧连接的 close 事件。
    desktop.socket.pause();
    const phoneClosed = expectClose(control, 4010);
    const second = await openDesktop(relay.baseUrl, desktopCredential);
    await phoneClosed;

    const control2 = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    const open = await second.nextMessage();
    const channelId = (open['payload'] as { channelId: string }).channelId;

    desktop.socket.send(
      JSON.stringify({
        type: 'channel.data',
        payload: { channelId, binary: false, data: 'FROM-OLD-GENERATION' },
      }),
    );
    await expect(nextPhoneText(control2, 300)).rejects.toThrow('message timeout');
    expect(control2.readyState).toBe(WebSocket.OPEN);
    desktop.socket.resume();
    control2.close();
    second.close();
  });
});