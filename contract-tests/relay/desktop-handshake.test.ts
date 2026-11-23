import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  Credential,
  createAccount,
  desktopLogin,
  expectClose,
  listDesktops,
  login,
  openDesktop,
} from './helpers/clients.js';
import { RelayHandle, startRelay, waitFor } from './helpers/harness.js';

const IS_EXTERNAL = process.env['RELAY_BASE_URL'] !== undefined;
const PASSWORD = 'pw-123456';

let handle: RelayHandle | null = null;

afterEach(async () => {
  await handle?.stop();
  handle = null;
});

async function setup(
  options?: { dataDir?: string },
): Promise<{ credential: Credential; handle: RelayHandle }> {
  handle = await startRelay(options);
  await createAccount(handle, 'alice', PASSWORD);
  const credential = await login(
    handle.baseUrl,
    desktopLogin('alice', PASSWORD),
  );
  return { credential, handle };
}

describe('契约 §5.1 桌面握手', () => {
  it('握手、代次递增、取代旧连接', async () => {
    const { credential, handle: relay } = await setup();
    const first = await openDesktop(relay.baseUrl, credential);
    expect(first.epoch).toBe(1);

    const firstClosed = expectClose(first.socket, 4000);
    const second = await openDesktop(relay.baseUrl, credential);
    expect(second.epoch).toBe(2);
    await firstClosed;
    second.close();
  });

  it.skipIf(IS_EXTERNAL)(
    '重启后代次不回退（Review Focus 1）',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'relay-restart-'));
      try {
        const firstRun = await setup({ dataDir });
        const before = await openDesktop(firstRun.handle.baseUrl, firstRun.credential);
        const beforeEpoch = before.epoch;
        before.close();
        await firstRun.handle.stop();

        handle = await startRelay({ dataDir });
        const after = await openDesktop(handle.baseUrl, firstRun.credential);
        expect(after.epoch).toBeGreaterThan(beforeEpoch);
        after.close();
      } finally {
        await handle?.stop();
        handle = null;
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  );

  it('desktops.online 反映真实连接状态', async () => {
    const { credential, handle: relay } = await setup();
    const before = await listDesktops(relay.baseUrl, credential);
    expect(before).toHaveLength(1);
    expect(before[0]?.['online']).toBe(false);

    const desktop = await openDesktop(relay.baseUrl, credential);
    const during = await listDesktops(relay.baseUrl, credential);
    expect(during[0]?.['online']).toBe(true);

    desktop.close();
    await waitFor(async () => {
      const after = await listDesktops(relay.baseUrl, credential);
      return after[0]?.['online'] === false;
    });
  });
});