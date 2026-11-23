import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sendAdminRequest } from '../src/admin/client.js';
import { verifyPasswordHash, hashPassword, tokenMatches, hashToken } from '../src/security/credentials.js';

let dir: string | null = null;

afterEach(() => {
  if (dir !== null) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe('admin client 错误路径', () => {
  it('relay 未运行（无 socket）→ ADMIN_UNAVAILABLE', async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-client-'));
    const response = await sendAdminRequest(dir, { op: 'list-accounts' });
    expect(response).toEqual({
      ok: false,
      error: { code: 'ADMIN_UNAVAILABLE', message: 'ADMIN_UNAVAILABLE' },
    });
  });
});

describe('credential 工具', () => {
  it('口令哈希往返；格式非法一律 false', () => {
    const stored = hashPassword('pw-123456');
    expect(verifyPasswordHash('pw-123456', stored)).toBe(true);
    expect(verifyPasswordHash('wrong', stored)).toBe(false);
    expect(verifyPasswordHash('pw-123456', 'plain')).toBe(false);
    expect(verifyPasswordHash('pw-123456', 'scrypt:zz:zz')).toBe(false);
    expect(verifyPasswordHash('pw-123456', 'sha256:aabb:ccdd')).toBe(false);
  });

  it('tokenMatches 常量时间比较；格式非法 false', () => {
    const token = 'tok_value';
    expect(tokenMatches(token, hashToken(token))).toBe(true);
    expect(tokenMatches('other', hashToken(token))).toBe(false);
    expect(tokenMatches(token, 'not-hex-or-wrong-length')).toBe(false);
  });
});