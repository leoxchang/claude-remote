import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openRelayStore } from '../src/storage/sqlite-store.js';
import { RelayStore } from '../src/storage/store.js';

let dir: string;
let store: RelayStore | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-store-'));
});

afterEach(() => {
  store?.close();
  store = null;
  rmSync(dir, { recursive: true, force: true });
});

function createDesktopDevice(
  activeStore: RelayStore,
  accountId: string,
): { deviceId: string; deviceToken: string } {
  const created = activeStore.createDevice({
    accountId,
    role: 'desktop',
    deviceName: 'Mac',
    platform: 'macos',
    appVersion: '1.0.0',
  });
  return {
    deviceId: created.device.deviceId,
    deviceToken: created.deviceToken,
  };
}

describe('账号', () => {
  it('创建账号并校验口令；错误口令与不存在用户名同样返回 null', () => {
    store = openRelayStore(dir);
    store.createAccount('alice', 'pw-123456');
    expect(store.verifyPassword('alice', 'pw-123456')?.username).toBe('alice');
    expect(store.verifyPassword('alice', 'wrong')).toBeNull();
    expect(store.verifyPassword('nobody', 'pw-123456')).toBeNull();
    expect(() => store?.createAccount('alice', 'x')).toThrow('USERNAME_TAKEN');
  });

  it('setPassword 后旧口令失效、新口令生效', () => {
    store = openRelayStore(dir);
    store.createAccount('alice', 'pw-123456');
    store.setPassword('alice', 'pw-654321');
    expect(store.verifyPassword('alice', 'pw-123456')).toBeNull();
    expect(store.verifyPassword('alice', 'pw-654321')?.username).toBe('alice');
    expect(() => store?.setPassword('nobody', 'pw')).toThrow('ACCOUNT_NOT_FOUND');
  });

  it('setAccountDisabled 往返切换 disabled 标记', () => {
    store = openRelayStore(dir);
    store.createAccount('alice', 'pw-123456');
    store.setAccountDisabled('alice', true);
    expect(store.findAccountByUsername('alice')?.disabled).toBe(true);
    store.setAccountDisabled('alice', false);
    expect(store.findAccountByUsername('alice')?.disabled).toBe(false);
  });
});

describe('设备', () => {
  it('设备令牌只出现一次且可校验；吊销后失效', () => {
    store = openRelayStore(dir);
    const account = store.createAccount('alice', 'pw-123456');
    const { device, deviceToken } = store.createDevice({
      accountId: account.accountId,
      role: 'desktop',
      deviceName: 'Mac',
      platform: 'macos',
      appVersion: '1.0.0',
    });
    expect(store.verifyDevice(device.deviceId, deviceToken)?.deviceId).toBe(
      device.deviceId,
    );
    expect(store.verifyDevice(device.deviceId, 'bad')).toBeNull();
    store.revokeDevice(account.accountId, device.deviceId);
    expect(store.verifyDevice(device.deviceId, deviceToken)).toBeNull();
  });

  it('账号禁用后 verifyDevice 返回 null，启用后恢复', () => {
    store = openRelayStore(dir);
    const account = store.createAccount('alice', 'pw-123456');
    const { deviceId, deviceToken } = createDesktopDevice(
      store,
      account.accountId,
    );
    store.setAccountDisabled('alice', true);
    expect(store.verifyDevice(deviceId, deviceToken)).toBeNull();
    store.setAccountDisabled('alice', false);
    expect(store.verifyDevice(deviceId, deviceToken)?.deviceId).toBe(deviceId);
  });

  it('未吊销设备数达上限抛 DEVICE_LIMIT_REACHED；吊销释放名额', () => {
    store = openRelayStore(dir, 2);
    const account = store.createAccount('alice', 'pw-123456');
    const first = createDesktopDevice(store, account.accountId);
    createDesktopDevice(store, account.accountId);
    expect(() =>
      store?.createDevice({
        accountId: account.accountId,
        role: 'phone',
        deviceName: 'iPhone',
        platform: 'ios',
        appVersion: '1.0.0',
      }),
    ).toThrow('DEVICE_LIMIT_REACHED');
    store.revokeDevice(account.accountId, first.deviceId);
    const created = store.createDevice({
      accountId: account.accountId,
      role: 'phone',
      deviceName: 'iPhone',
      platform: 'ios',
      appVersion: '1.0.0',
    });
    expect(created.device.role).toBe('phone');
  });

  it('listDevices 只返回本账号设备，findDevice 按 ID 查找', () => {
    store = openRelayStore(dir);
    const alice = store.createAccount('alice', 'pw-123456');
    const bob = store.createAccount('bob', 'pw-123456');
    createDesktopDevice(store, alice.accountId);
    createDesktopDevice(store, bob.accountId);
    expect(store.listDevices(alice.accountId)).toHaveLength(1);
    expect(store.listDevices(bob.accountId)).toHaveLength(1);
  });

  it('跨账号 revokeDevice 返回 false 且不生效', () => {
    store = openRelayStore(dir);
    const alice = store.createAccount('alice', 'pw-123456');
    const bob = store.createAccount('bob', 'pw-123456');
    const bobDevice = createDesktopDevice(store, bob.accountId);
    expect(store.revokeDevice(alice.accountId, bobDevice.deviceId)).toBe(false);
    expect(
      store.verifyDevice(bobDevice.deviceId, bobDevice.deviceToken),
    ).not.toBeNull();
  });

  it('connectionEpoch 持久化：重开库后继续递增（Review Focus 1）', () => {
    store = openRelayStore(dir);
    const account = store.createAccount('alice', 'pw-123456');
    const { deviceId } = createDesktopDevice(store, account.accountId);
    expect(store.nextConnectionEpoch(deviceId)).toBe(1);
    expect(store.nextConnectionEpoch(deviceId)).toBe(2);
    store.close();
    store = openRelayStore(dir);
    expect(store.nextConnectionEpoch(deviceId)).toBe(3);
  });

  it('未知用户名同样执行一次哈希校验（防时序枚举，I5）', () => {
    const calls: string[] = [];
    store = openRelayStore(dir, undefined, {
      verifyHash: (_password, stored) => {
        calls.push(stored);
        return false;
      },
    });
    store.createAccount('alice', 'pw-123456');
    calls.length = 0;
    expect(store.verifyPassword('ghost', 'pw-123456')).toBeNull();
    expect(calls).toHaveLength(1);
    calls.length = 0;
    expect(store.verifyPassword('alice', 'wrong')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('touchLastSeen 记录最近断开时间', () => {
    store = openRelayStore(dir);
    const account = store.createAccount('alice', 'pw-123456');
    const { deviceId } = createDesktopDevice(store, account.accountId);
    expect(store.findDevice(deviceId)?.lastSeenAt).toBeNull();
    store.touchLastSeen(deviceId);
    expect(store.findDevice(deviceId)?.lastSeenAt).toEqual(expect.any(Number));
  });
});