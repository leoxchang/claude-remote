import { DeviceRecord, RelayStore } from '../storage/store.js';

/** 鉴权失败只有对外一个码，不泄漏设备是否存在。 */
export type AuthErrorCode = 'UNAUTHENTICATED';

/** 鉴权失败。 */
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode = 'UNAUTHENTICATED') {
    super(code);
    this.name = 'AuthError';
  }
}

const BEARER_PREFIX = 'bearer ';

/**
 * 只从 Authorization 头校验 `<deviceId>.<deviceToken>`。
 * 不接受 query string、子协议或任何 URL 携带的凭证。
 */
export function authenticateBearer(
  store: RelayStore,
  headers: Record<string, unknown>,
): DeviceRecord {
  const raw = headers['authorization'];
  if (typeof raw !== 'string' || !raw.toLowerCase().startsWith(BEARER_PREFIX)) {
    throw new AuthError();
  }
  const credentials = raw.slice(BEARER_PREFIX.length).trim();
  const separator = credentials.indexOf('.');
  if (separator <= 0 || separator === credentials.length - 1) {
    throw new AuthError();
  }
  const deviceId = credentials.slice(0, separator);
  const token = credentials.slice(separator + 1);
  const device = store.verifyDevice(deviceId, token);
  if (device === null) throw new AuthError();
  return device;
}