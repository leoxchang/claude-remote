import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SALT_BYTES = 16;
const HASH_BYTES = 64;
const TOKEN_BYTES = 32;
const SALT_HEX_LENGTH = SALT_BYTES * 2;
const HASH_HEX_LENGTH = HASH_BYTES * 2;
const SCRYPT_PREFIX = 'scrypt';
const SEPARATOR = ':';

/** 口令加盐慢哈希；格式 `scrypt:<saltHex>:<hashHex>`。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, HASH_BYTES);
  return [SCRYPT_PREFIX, salt.toString('hex'), hash.toString('hex')].join(
    SEPARATOR,
  );
}

/** 常量时间校验口令；格式不符一律 false。 */
export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split(SEPARATOR);
  if (parts.length !== 3 || parts[0] !== SCRYPT_PREFIX) return false;
  const saltHex = parts[1] ?? '';
  const hashHex = parts[2] ?? '';
  if (saltHex.length !== SALT_HEX_LENGTH || hashHex.length !== HASH_HEX_LENGTH)
    return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), HASH_BYTES);
  return timingSafeEqual(actual, expected);
}

/** 生成设备令牌：32 字节随机熵，base64url。 */
export function newDeviceToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** 令牌落盘哈希；库泄漏不泄漏令牌。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 常量时间比较令牌哈希；格式不符一律 false。 */
export function tokenMatches(token: string, storedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** 生成 `acc_`/`dev_` 前缀的随机 ID。 */
export function newPrefixedId(prefix: string): string {
  return `${prefix}${randomBytes(9).toString('base64url')}`;
}