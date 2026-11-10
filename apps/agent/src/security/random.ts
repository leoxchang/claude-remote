import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 设备令牌与配对 code 的默认字节数（256 位）。 */
export const TOKEN_BYTES = 32;

/** 生成 base64url 随机串。 */
export function randomBase64Url(bytes: number = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/** 计算 SHA-256 的 base64url 摘要。 */
export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/** 恒定时间比较两个 base64url 摘要。 */
export function safeEqualBase64Url(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'base64url');
  const rightBytes = Buffer.from(right, 'base64url');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}