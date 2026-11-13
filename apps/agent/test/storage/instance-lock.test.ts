import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InstanceLock } from '../../src/storage/instance-lock.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 's04-lock-'));
  return {
    dir,
    lockPath: join(dir, 'agent.lock'),
    databasePath: join(dir, 'agent.sqlite3'),
  };
}

describe('InstanceLock', () => {
  it('rejects a second instance while the owner process is alive', () => {
    const { lockPath, databasePath } = fixture();
    const first = InstanceLock.acquire({
      lockPath,
      desktopId: 'desktop_1',
      databasePath,
      pid: process.pid,
    });
    try {
      expect(() =>
        InstanceLock.acquire({
          lockPath,
          desktopId: 'desktop_1',
          databasePath,
          pid: process.pid,
        }),
      ).toThrow(/AGENT_ALREADY_RUNNING/);
    } finally {
      first.release();
    }
  });

  it('recovers a lock whose recorded process is dead', () => {
    const { lockPath, databasePath } = fixture();
    const stale = InstanceLock.acquire({
      lockPath,
      desktopId: 'desktop_1',
      databasePath,
      pid: 999_999,
      isProcessAlive: () => false,
    });
    expect(stale.info().pid).toBe(999_999);

    const current = InstanceLock.acquire({
      lockPath,
      desktopId: 'desktop_1',
      databasePath,
      pid: process.pid,
    });
    try {
      expect(current.info().pid).toBe(process.pid);
    } finally {
      current.release();
    }
  });

  it('never steals a lock from a live process', () => {
    const { lockPath, databasePath } = fixture();
    const first = InstanceLock.acquire({
      lockPath,
      desktopId: 'desktop_1',
      databasePath,
      pid: 4242,
      isProcessAlive: () => true,
    });
    try {
      expect(() =>
        InstanceLock.acquire({
          lockPath,
          desktopId: 'desktop_1',
          databasePath,
          pid: process.pid,
          isProcessAlive: () => true,
        }),
      ).toThrow(/AGENT_ALREADY_RUNNING/);
    } finally {
      first.release();
    }
  });

  it('releases lock and metadata with 0600, then allows reacquire', () => {
    const { dir, lockPath, databasePath } = fixture();
    const handle = InstanceLock.acquire({
      lockPath,
      desktopId: 'desktop_1',
      databasePath,
      pid: process.pid,
    });
    const metadataPath = `${lockPath}.json`;
    expect(statSync(metadataPath).mode & 0o777).toBe(0o600);
    const info = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
      desktopId: string;
      databasePath: string;
    };
    expect(info.desktopId).toBe('desktop_1');
    expect(info.databasePath).toBe(
      join(realpathSync(dir), 'agent.sqlite3'),
    );

    handle.release();
    expect(existsSync(metadataPath)).toBe(false);
    expect(existsSync(`${lockPath}.lock`)).toBe(false);

    const again = InstanceLock.acquire({
      lockPath,
      desktopId: 'desktop_1',
      databasePath,
      pid: process.pid,
    });
    again.release();
  });
});