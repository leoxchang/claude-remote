import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentDatabase } from '../../src/storage/database.js';
import { SqliteDeviceStore } from '../../src/storage/repositories/device-repository.js';
import { sha256Base64Url } from '../../src/security/random.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 's04-devices-'));
  const path = join(dir, 'agent.sqlite3');
  const db = AgentDatabase.open(path);
  return { dir, path, db, store: new SqliteDeviceStore(db.uow) };
}

describe('SqliteDeviceStore', () => {
  it('keeps create/verify/revoke/active semantics and persists across reopen', async () => {
    const context = fixture();
    try {
      const created = await context.store.create(
        'device_1',
        'iPhone',
        sha256Base64Url('token-1'),
      );
      expect(created.revokedAt).toBeNull();
      expect(await context.store.verify('device_1', 'token-1')).toMatchObject({
        deviceId: 'device_1',
      });
      expect(await context.store.verify('device_1', 'wrong')).toBeNull();
      expect(await context.store.verify('unknown', 'token-1')).toBeNull();
      expect(context.store.active()?.deviceId).toBe('device_1');
      const revoked = await context.store.revoke('device_1');
      expect(revoked.revokedAt).not.toBeNull();
      expect(await context.store.verify('device_1', 'token-1')).toBeNull();
      expect(context.store.active()).toBeNull();
    } finally {
      context.db.close();
    }

    const reopened = AgentDatabase.open(context.path);
    try {
      const store = new SqliteDeviceStore(reopened.uow);
      expect(store.active()).toBeNull();
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]).toMatchObject({
        deviceId: 'device_1',
        revokedAt: expect.any(String),
      });
    } finally {
      reopened.close();
    }
  });

  it('stores only token hashes and allows exactly one active device', async () => {
    const context = fixture();
    try {
      await context.store.create('device_1', 'iPhone', sha256Base64Url('token-1'));
      // 旧设备未 revoke 前不能变成两部 active。
      await expect(
        context.store.create('device_2', 'Other', sha256Base64Url('token-2')),
      ).rejects.toThrow(/UNIQUE/);
      await context.store.revoke('device_1');
      await context.store.create('device_2', 'Other', sha256Base64Url('token-2'));

      const rows = context.db.connection
        .prepare('SELECT tokenHash FROM devices')
        .all() as { tokenHash: string }[];
      expect(new Set(rows.map((row) => row.tokenHash))).toEqual(
        new Set([sha256Base64Url('token-1'), sha256Base64Url('token-2')]),
      );
      for (const row of rows) {
        expect(row.tokenHash).not.toBe('token-1');
        expect(row.tokenHash).not.toBe('token-2');
      }
    } finally {
      context.db.close();
    }
  });

  it('requires revoking the old device before a replacement becomes active', async () => {
    const context = fixture();
    try {
      await context.store.create('device_1', 'iPhone', sha256Base64Url('token-1'));
      await context.store.revoke('device_1');
      await context.store.create('device_2', 'iPhone 2', sha256Base64Url('token-2'));
      expect(context.store.active()?.deviceId).toBe('device_2');
      await expect(context.store.revoke('missing')).rejects.toThrow(
        /unknown device/,
      );
    } finally {
      context.db.close();
    }
  });
});