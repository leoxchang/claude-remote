import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { NetworkInterfaceInfo, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  detectLanAddress,
  disableLan,
  enableLan,
  lanStatus,
} from '../src/config/lan.js';

const TUNNEL_URL = 'https://mac.example-tailnet.ts.net';

const V4_CONFIG = {
  version: 4,
  desktopId: 'desktop_test',
  database: { file: 'agent.sqlite3' },
  listen: { host: '127.0.0.1', port: 8787 },
  tailscale: { baseUrl: TUNNEL_URL },
};

async function setup(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 's07-lan-'));
  await writeFile(join(directory, 'agent.json'), JSON.stringify(V4_CONFIG));
  return directory;
}

function info(
  address: string,
  family: 'IPv4' | 'IPv6',
  internal: boolean,
): NetworkInterfaceInfo {
  if (family === 'IPv6') {
    return {
      address,
      netmask: 'ffff:ffff:ffff:ffff::',
      family,
      mac: '00:00:00:00:00:00',
      internal,
      cidr: `${address}/64`,
      scopeid: 0,
    };
  }
  return {
    address,
    netmask: '255.255.255.0',
    family,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

describe('detectLanAddress', () => {
  it('prefers en0 and skips loopback, IPv6 and link-local', () => {
    const address = detectLanAddress({
      en1: [info('192.168.9.2', 'IPv4', false)],
      en0: [
        info('127.0.0.1', 'IPv4', true),
        info('fe80::1', 'IPv6', false),
        info('169.254.10.20', 'IPv4', false),
        info('192.168.5.10', 'IPv4', false),
      ],
    });

    expect(address).toBe('192.168.5.10');
  });

  it('returns null when no private IPv4 exists', () => {
    expect(
      detectLanAddress({ en0: [info('127.0.0.1', 'IPv4', true)] }),
    ).toBeNull();
  });
});

describe('LAN mode', () => {
  it('writes 0.0.0.0 and a private http url with a 0600 backup', async () => {
    const directory = await setup();

    const result = await enableLan(directory, { lanAddress: '192.168.5.10' });

    expect(result.baseUrl).toBe('http://192.168.5.10:8787');
    const stored = JSON.parse(
      await readFile(join(directory, 'agent.json'), 'utf8'),
    ) as { listen: { host: string }; tailscale: { baseUrl: string } };
    expect(stored.listen.host).toBe('0.0.0.0');
    expect(stored.tailscale.baseUrl).toBe('http://192.168.5.10:8787');

    const backup = JSON.parse(await readFile(result.backupPath, 'utf8')) as {
      listen: { host: string };
    };
    expect(backup.listen.host).toBe('127.0.0.1');
    expect((await stat(result.backupPath)).mode & 0o777).toBe(0o600);
  });

  it('reports LAN and tunnel modes', async () => {
    const directory = await setup();

    expect(lanStatus(directory).mode).toBe('tunnel');
    await enableLan(directory, { lanAddress: '192.168.5.10' });
    const status = lanStatus(directory);

    expect(status.mode).toBe('lan');
    expect(status.baseUrl).toBe('http://192.168.5.10:8787');
  });

  it('disables LAN mode with an https tunnel url', async () => {
    const directory = await setup();
    await enableLan(directory, { lanAddress: '192.168.5.10' });

    const result = disableLan(directory, 'https://remote.example.com');

    expect(result.listen.host).toBe('127.0.0.1');
    expect(lanStatus(directory).mode).toBe('tunnel');
    expect(() => disableLan(directory, 'http://192.168.5.10:8787')).toThrow(
      /https/i,
    );
  });

  it('requires a V4 configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 's07-lan-v3-'));
    await writeFile(
      join(directory, 'agent.json'),
      JSON.stringify({ version: 3 }),
    );

    await expect(
      enableLan(directory, { lanAddress: '192.168.5.10' }),
    ).rejects.toThrow(/V4/i);
  });
});