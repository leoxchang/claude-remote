/** 账号与设备的持久化记录；不含任何凭证明文。 */
export interface AccountRecord {
  accountId: string;
  username: string;
  disabled: boolean;
  createdAt: number;
}

/** 设备记录；deviceToken 只在创建时出现一次，库中只存哈希。 */
export interface DeviceRecord {
  deviceId: string;
  accountId: string;
  role: 'phone' | 'desktop';
  deviceName: string;
  platform: string;
  appVersion: string;
  revoked: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  connectionEpoch: number;
}

/** 创建设备的输入；设备 ID 与令牌由存储生成。 */
export interface CreateDeviceInput {
  accountId: string;
  role: 'phone' | 'desktop';
  deviceName: string;
  platform: string;
  appVersion: string;
}

/** 存储层稳定错误码。 */
export type StoreErrorCode =
  | 'USERNAME_TAKEN'
  | 'ACCOUNT_NOT_FOUND'
  | 'DEVICE_LIMIT_REACHED';

/** 存储层错误；code 对外映射为契约错误码。 */
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(code);
    this.name = 'StoreError';
  }
}

/**
 * Relay 的账号/设备注册表。
 * verifyPassword 对不存在用户名与错误口令都返回 null；
 * verifyDevice 对无效、已吊销或账号禁用的设备一律返回 null。
 */
export interface RelayStore {
  createAccount(username: string, password: string): AccountRecord;
  findAccountByUsername(username: string): AccountRecord | null;
  verifyPassword(username: string, password: string): AccountRecord | null;
  setPassword(username: string, password: string): void;
  setAccountDisabled(username: string, disabled: boolean): void;
  listAccounts(): AccountRecord[];
  createDevice(input: CreateDeviceInput): {
    device: DeviceRecord;
    deviceToken: string;
  };
  verifyDevice(deviceId: string, token: string): DeviceRecord | null;
  findDevice(deviceId: string): DeviceRecord | null;
  listDevices(accountId: string): DeviceRecord[];
  revokeDevice(accountId: string, deviceId: string): boolean;
  nextConnectionEpoch(deviceId: string): number;
  touchLastSeen(deviceId: string): void;
  close(): void;
}