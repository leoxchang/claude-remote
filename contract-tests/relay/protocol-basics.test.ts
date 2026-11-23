import { afterEach, describe, expect, it } from 'vitest';

import {
  bearer,
  createAccount,
  desktopLogin,
  expectClose,
  login,
  nextSocketMessage,
  openDesktop,
  openRawDesktop,
  phoneLogin,
} from './helpers/clients.js';
import { RelayHandle, startRelay } from './helpers/harness.js';

const PASSWORD = 'pw-123456';

let handle: RelayHandle | null = null;

afterEach(async () => {
  await handle?.stop();
  handle = null;
});

describe('契约 §3.5 / §2.1 / §5.1 基础协议', () => {
  it('GET /v1/version 免鉴权返回契约版本', async () => {
    handle = await startRelay();
    const response = await fetch(`${handle.baseUrl}/v1/version`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ contractVersion: 1 });
  });

  it('登录限流：同一用户名第 11 次尝试返回 429 RATE_LIMITED', async () => {
    handle = await startRelay();
    await createAccount(handle, 'alice', PASSWORD);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetch(`${handle.baseUrl}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...desktopLogin('alice', 'wrong-password'),
        }),
      });
      expect(response.status).toBe(401);
    }
    const eleventh = await fetch(`${handle.baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(desktopLogin('alice', PASSWORD)),
    });
    expect(eleventh.status).toBe(429);
    expect(
      ((await eleventh.json()) as { error: { code: string } }).error.code,
    ).toBe('RATE_LIMITED');
  });

  it('版本无交集 → error VERSION_INCOMPATIBLE + close 4002', async () => {
    handle = await startRelay();
    await createAccount(handle, 'alice', PASSWORD);
    const credential = await login(
      handle.baseUrl,
      desktopLogin('alice', PASSWORD),
    );
    const socket = await openRawDesktop(handle.baseUrl, credential);
    const errorMessage = nextSocketMessage(socket);
    const closed = expectClose(socket, 4002);
    socket.send(
      JSON.stringify({
        type: 'desktop.hello',
        payload: {
          supportedContractVersions: [99],
          appVersion: '1.0.0',
          desktopName: 'Future Mac',
          platform: 'macos',
          handshakeId: 'hs_future',
        },
      }),
    );
    expect(await errorMessage).toMatchObject({
      type: 'error',
      payload: { error: { code: 'VERSION_INCOMPATIBLE' } },
    });
    await closed;
  });
});

describe('契约 §3.2 / §3.3 / §3.4 设备列表与吊销', () => {
  it('desktops 仅含桌面角色；devices 含角色且不含令牌', async () => {
    handle = await startRelay();
    await createAccount(handle, 'alice', PASSWORD);
    const desktopCredential = await login(
      handle.baseUrl,
      desktopLogin('alice', PASSWORD),
    );
    const phone = await login(handle.baseUrl, phoneLogin('alice', PASSWORD));

    const desktopsResponse = await fetch(`${handle.baseUrl}/v1/desktops`, {
      headers: { authorization: bearer(phone) },
    });
    expect(desktopsResponse.status).toBe(200);
    const desktops = (await desktopsResponse.json()) as {
      desktops: Array<Record<string, unknown>>;
    };
    expect(desktops.desktops).toHaveLength(1);
    expect(desktops.desktops[0]).toMatchObject({
      desktopId: desktopCredential.deviceId,
      desktopName: 'Contract Mac',
      online: false,
      lastSeenAt: null,
    });

    const devicesResponse = await fetch(`${handle.baseUrl}/v1/devices`, {
      headers: { authorization: bearer(phone) },
    });
    const devices = (await devicesResponse.json()) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(devices.devices).toHaveLength(2);
    const roles = devices.devices.map((entry) => entry['role']).sort();
    expect(roles).toEqual(['desktop', 'phone']);
    expect(devices.devices.every((entry) => entry['deviceToken'] === undefined)).toBe(
      true,
    );
  });

  it('DELETE 他账号设备 → 404 DEVICE_NOT_FOUND 且不生效', async () => {
    handle = await startRelay();
    await createAccount(handle, 'alice', PASSWORD);
    await createAccount(handle, 'bob', PASSWORD);
    const bobDesktop = await login(
      handle.baseUrl,
      desktopLogin('bob', PASSWORD),
    );
    const alicePhone = await login(
      handle.baseUrl,
      phoneLogin('alice', PASSWORD),
    );

    const response = await fetch(
      `${handle.baseUrl}/v1/devices/${bobDesktop.deviceId}`,
      { method: 'DELETE', headers: { authorization: bearer(alicePhone) } },
    );
    expect(response.status).toBe(404);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe('DEVICE_NOT_FOUND');

    const bobConnection = await openDesktop(handle.baseUrl, bobDesktop);
    bobConnection.close();
  });
});