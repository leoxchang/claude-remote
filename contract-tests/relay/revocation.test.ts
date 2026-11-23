import { afterEach, describe, expect, it } from 'vitest';

import {
  attemptPhone,
  bearer,
  Credential,
  createAccount,
  desktopLogin,
  expectClose,
  login,
  openDesktop,
  openPhone,
  phoneLogin,
} from './helpers/clients.js';
import { RelayHandle, runAdmin, startRelay } from './helpers/harness.js';

const PASSWORD = 'pw-123456';

let handle: RelayHandle | null = null;

afterEach(async () => {
  await handle?.stop();
  handle = null;
});

interface Setup {
  relay: RelayHandle;
  desktop: Awaited<ReturnType<typeof openDesktop>>;
  desktopCredential: Credential;
  phone: Credential;
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
  return { relay: handle, desktop, desktopCredential, phone };
}

describe('契约 §3.4/§7 即时吊销', () => {
  it('DELETE 手机设备 → control+asr 立即 4004，令牌失效', async () => {
    const { relay, desktopCredential, phone } = await setup();
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

    const controlClosed = expectClose(control, 4004);
    const asrClosed = expectClose(asr, 4004);
    const response = await fetch(
      `${relay.baseUrl}/v1/devices/${phone.deviceId}`,
      {
        method: 'DELETE',
        headers: { authorization: bearer(phone) },
      },
    );
    expect(response.status).toBe(204);
    await controlClosed;
    await asrClosed;

    const retry = await attemptPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    expect(retry).toEqual({ ok: false, status: 401 });
  });

  it('吊销桌面 → 桌面 4004、挂载手机 4010；后续新登录不受影响', async () => {
    const { relay, desktop, desktopCredential, phone } = await setup();
    const socket = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    await desktop.nextMessage();

    const desktopClosed = expectClose(desktop.socket, 4004);
    const phoneClosed = expectClose(socket, 4010);
    const response = await fetch(
      `${relay.baseUrl}/v1/devices/${desktopCredential.deviceId}`,
      {
        method: 'DELETE',
        headers: { authorization: bearer(phone) },
      },
    );
    expect(response.status).toBe(204);
    await desktopClosed;
    await phoneClosed;

    const renewed = await login(relay.baseUrl, desktopLogin('alice', PASSWORD));
    expect(renewed.deviceId).not.toBe(desktopCredential.deviceId);
    const desktopAgain = await openDesktop(relay.baseUrl, renewed);
    desktopAgain.close();
  });

  it('admin disable-user → 账号全部存活连接 4004，新登录 403', async () => {
    const { relay, desktop, desktopCredential, phone } = await setup();
    const socket = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    await desktop.nextMessage();

    const desktopClosed = expectClose(desktop.socket, 4004);
    const phoneClosed = expectClose(socket, 4004);
    await runAdmin(relay, ['admin', 'disable-user', 'alice']);
    await desktopClosed;
    await phoneClosed;

    const rejected = await fetch(`${relay.baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(desktopLogin('alice', PASSWORD)),
    });
    expect(rejected.status).toBe(403);
  });

  it('admin revoke-device 与 REST DELETE 效果一致', async () => {
    const { relay, desktopCredential, phone } = await setup();
    const socket = await openPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );

    const phoneClosed = expectClose(socket, 4004);
    const output = await runAdmin(relay, [
      'admin',
      'revoke-device',
      phone.deviceId,
    ]);
    expect(output).toBe('null');
    await phoneClosed;

    const retry = await attemptPhone(
      relay.baseUrl,
      phone,
      desktopCredential.deviceId,
      'control',
    );
    expect(retry).toEqual({ ok: false, status: 401 });
  });
});