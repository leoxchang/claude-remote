import { mkdtempSync, rmSync } from 'node:fs';
import { connect, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';

import { ADMIN_SOCKET_FILE, startAdminSocket } from '../src/admin/admin-socket.js';
import { sendAdminRequest } from '../src/admin/client.js';
import { openRelayStore } from '../src/storage/sqlite-store.js';
import { DeviceRecord, RelayStore } from '../src/storage/store.js';

let dir: string;
let store: RelayStore;
let adminServer: Server;
let onAccountDisabled: Mock<(accountId: string) => void>;
let onDeviceRevoked: Mock<(device: DeviceRecord) => void>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-admin-'));
  store = openRelayStore(dir);
  onAccountDisabled = vi.fn<(accountId: string) => void>();
  onDeviceRevoked = vi.fn<(device: DeviceRecord) => void>();
  adminServer = await startAdminSocket({
    store,
    dataDir: dir,
    onAccountDisabled,
    onDeviceRevoked,
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    adminServer.close(() => resolve());
  });
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function sendRaw(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(dir, ADMIN_SOCKET_FILE));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
    });
    socket.on('end', () => resolve(buffer));
    socket.on('error', reject);
    socket.write(payload);
  });
}

describe('admin socket', () => {
  it('create-user 后可登录校验；重复创建返回 USERNAME_TAKEN', async () => {
    const response = await sendAdminRequest(dir, {
      op: 'create-user',
      username: 'alice',
      password: 'pw-123456',
    });
    expect(response.ok).toBe(true);
    expect(store.verifyPassword('alice', 'pw-123456')).not.toBeNull();
    const again = await sendAdminRequest(dir, {
      op: 'create-user',
      username: 'alice',
      password: 'x',
    });
    expect(again).toMatchObject({
      ok: false,
      error: { code: 'USERNAME_TAKEN' },
    });
  });

  it('reset-password 替换口令；disable/enable-user 往返切换', async () => {
    await sendAdminRequest(dir, {
      op: 'create-user',
      username: 'alice',
      password: 'pw-123456',
    });
    await sendAdminRequest(dir, {
      op: 'reset-password',
      username: 'alice',
      password: 'pw-654321',
    });
    expect(store.verifyPassword('alice', 'pw-123456')).toBeNull();
    expect(store.verifyPassword('alice', 'pw-654321')).not.toBeNull();

    await sendAdminRequest(dir, { op: 'disable-user', username: 'alice' });
    expect(store.findAccountByUsername('alice')?.disabled).toBe(true);
    await sendAdminRequest(dir, { op: 'enable-user', username: 'alice' });
    expect(store.findAccountByUsername('alice')?.disabled).toBe(false);
  });

  it('disable-user 触发 onAccountDisabled(accountId)', async () => {
    await sendAdminRequest(dir, {
      op: 'create-user',
      username: 'alice',
      password: 'pw-123456',
    });
    const account = store.findAccountByUsername('alice');
    await sendAdminRequest(dir, { op: 'disable-user', username: 'alice' });
    expect(onAccountDisabled).toHaveBeenCalledWith(account?.accountId);
  });

  it('revoke-device 触发 onDeviceRevoked(device) 且令牌失效', async () => {
    const account = store.createAccount('alice', 'pw-123456');
    const created = store.createDevice({
      accountId: account.accountId,
      role: 'phone',
      deviceName: 'iPhone',
      platform: 'ios',
      appVersion: '1.0.0',
    });
    const response = await sendAdminRequest(dir, {
      op: 'revoke-device',
      deviceId: created.device.deviceId,
    });
    expect(response.ok).toBe(true);
    expect(onDeviceRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: created.device.deviceId }),
    );
    expect(
      store.verifyDevice(created.device.deviceId, created.deviceToken),
    ).toBeNull();
  });

  it('list-accounts 与 list-devices 返回注册表数据', async () => {
    const created = await sendAdminRequest(dir, {
      op: 'create-user',
      username: 'alice',
      password: 'pw-123456',
    });
    expect(created.ok).toBe(true);
    const account = store.findAccountByUsername('alice');
    if (account === null) throw new Error('missing alice');
    store.createDevice({
      accountId: account.accountId,
      role: 'desktop',
      deviceName: 'Mac',
      platform: 'macos',
      appVersion: '1.0.0',
    });
    const accounts = await sendAdminRequest(dir, { op: 'list-accounts' });
    expect(accounts).toMatchObject({
      ok: true,
      result: [expect.objectContaining({ username: 'alice' })],
    });
    const devices = await sendAdminRequest(dir, {
      op: 'list-devices',
      username: 'alice',
    });
    expect(devices).toMatchObject({
      ok: true,
      result: [expect.objectContaining({ role: 'desktop' })],
    });
  });

  it('未知 op 与畸形 JSON 返回 INVALID_REQUEST', async () => {
    const unknownOp = await sendRaw('{"op":"nope"}\n');
    expect(JSON.parse(unknownOp)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    const malformed = await sendRaw('not json\n');
    expect(JSON.parse(malformed)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });
});