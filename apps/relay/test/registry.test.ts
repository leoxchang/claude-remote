import { WebSocket } from 'ws';

import { describe, expect, it } from 'vitest';

import { ConnectionRegistry } from '../src/routing/registry.js';
import { DeviceRecord } from '../src/storage/store.js';

class FakeSocket {
  readonly closed: Array<{ code: number; reason: string }> = [];
  readyState = WebSocket.OPEN;

  send(): void {}

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }
}

function device(
  deviceId: string,
  role: 'phone' | 'desktop',
  accountId = 'acc_1',
): DeviceRecord {
  return {
    deviceId,
    accountId,
    role,
    deviceName: deviceId,
    platform: role === 'desktop' ? 'macos' : 'ios',
    appVersion: '1.0.0',
    revoked: false,
    createdAt: 0,
    lastSeenAt: null,
    connectionEpoch: 0,
  };
}

describe('ConnectionRegistry 吊销联动', () => {
  it('closeDevice 关闭目标桌面与该设备的手机通道', () => {
    const registry = new ConnectionRegistry();
    const desktopSocket = new FakeSocket();
    const phoneSocket = new FakeSocket();
    const otherSocket = new FakeSocket();
    registry.attachDesktop(
      device('dev_desktop', 'desktop'),
      desktopSocket as unknown as WebSocket,
      1,
    );
    registry.attachPhone(
      device('dev_phone', 'phone'),
      'dev_desktop',
      'control',
      phoneSocket as unknown as WebSocket,
    );
    registry.attachPhone(
      device('dev_other', 'phone'),
      'dev_desktop',
      'control',
      otherSocket as unknown as WebSocket,
    );

    registry.closeDevice('dev_phone', 4004);
    expect(phoneSocket.closed).toEqual([{ code: 4004, reason: 'closed' }]);
    expect(otherSocket.closed).toHaveLength(0);

    registry.closeDevice('dev_desktop', 4004);
    expect(desktopSocket.closed).toEqual([{ code: 4004, reason: 'closed' }]);
    expect(otherSocket.closed).toHaveLength(0);
  });

  it('closeAccount 关闭该账号全部桌面与手机通道', () => {
    const registry = new ConnectionRegistry();
    const aliceDesktop = new FakeSocket();
    const alicePhone = new FakeSocket();
    const bobDesktop = new FakeSocket();
    registry.attachDesktop(
      device('dev_a_desktop', 'desktop', 'acc_a'),
      aliceDesktop as unknown as WebSocket,
      1,
    );
    registry.attachPhone(
      device('dev_a_phone', 'phone', 'acc_a'),
      'dev_a_desktop',
      'control',
      alicePhone as unknown as WebSocket,
    );
    registry.attachDesktop(
      device('dev_b_desktop', 'desktop', 'acc_b'),
      bobDesktop as unknown as WebSocket,
      1,
    );

    registry.closeAccount('acc_a', 4004);
    expect(aliceDesktop.closed).toEqual([{ code: 4004, reason: 'closed' }]);
    expect(alicePhone.closed).toEqual([{ code: 4004, reason: 'closed' }]);
    expect(bobDesktop.closed).toHaveLength(0);
  });

  it('attachPhone 同 (deviceId, kind) 取代旧通道 4000；不同 kind 并存', () => {
    const registry = new ConnectionRegistry();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const asr = new FakeSocket();
    registry.attachPhone(
      device('dev_phone', 'phone'),
      'dev_desktop',
      'control',
      first as unknown as WebSocket,
    );
    registry.attachPhone(
      device('dev_phone', 'phone'),
      'dev_desktop',
      'control',
      second as unknown as WebSocket,
    );
    expect(first.closed).toEqual([{ code: 4000, reason: 'superseded' }]);
    expect(second.closed).toHaveLength(0);

    registry.attachPhone(
      device('dev_phone', 'phone'),
      'dev_desktop',
      'asr',
      asr as unknown as WebSocket,
    );
    expect(second.closed).toHaveLength(0);
    expect(asr.closed).toHaveLength(0);
  });

  it('detachDesktop 只清除当前连接', () => {
    const registry = new ConnectionRegistry();
    const oldSocket = new FakeSocket();
    const newSocket = new FakeSocket();
    const oldLink = registry.attachDesktop(
      device('dev_desktop', 'desktop'),
      oldSocket as unknown as WebSocket,
      1,
    );
    registry.attachDesktop(
      device('dev_desktop', 'desktop'),
      newSocket as unknown as WebSocket,
      2,
    );
    registry.detachDesktop(oldLink);
    expect(registry.isOnline('dev_desktop')).toBe(true);
  });
});