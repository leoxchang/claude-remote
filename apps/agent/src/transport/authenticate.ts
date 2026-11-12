import { DeviceRecord } from '../domain/types.js';
import { DeviceStore } from '../store/device-store.js';

/** 升级前鉴权失败只有一个对外码，避免泄露设备是否存在。 */
export type AuthenticationErrorCode = 'UNAUTHENTICATED';

/** 升级前鉴权失败。 */
export class AuthenticationError extends Error {
  constructor(
    readonly code: AuthenticationErrorCode = 'UNAUTHENTICATED',
    message: string = 'unauthenticated',
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

const BEARER_PREFIX = 'bearer ';

/**
 * 只从 Authorization 头校验 `<deviceId>.<deviceToken>`。
 * 不接受 query string、subprotocol 或任何 URL 携带的凭证。
 */
export async function authenticateRequest(
  headers: Record<string, unknown>,
  store: DeviceStore,
): Promise<DeviceRecord> {
  const raw = headers['authorization'];
  if (typeof raw !== 'string' || !raw.toLowerCase().startsWith(BEARER_PREFIX)) {
    throw new AuthenticationError();
  }
  const credentials = raw.slice(BEARER_PREFIX.length).trim();
  const separator = credentials.indexOf('.');
  if (separator <= 0 || separator === credentials.length - 1) {
    throw new AuthenticationError();
  }
  const deviceId = credentials.slice(0, separator);
  const token = credentials.slice(separator + 1);
  const device = await store.verify(deviceId, token);
  if (device === null) {
    throw new AuthenticationError();
  }
  return device;
}

/** WSS 升级前鉴权；与 HTTP 请求共用同一 Bearer 规则。 */
export async function authenticateUpgrade(
  headers: Record<string, unknown>,
  store: DeviceStore,
): Promise<DeviceRecord> {
  return authenticateRequest(headers, store);
}