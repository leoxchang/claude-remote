import { existsSync, readFileSync } from 'node:fs';

import { writeFileAtomic } from '../config/atomic-file.js';
import { CONFIG_FILE_MODE, resolveAgentPaths } from '../config/paths.js';
import { DeviceRecord } from '../domain/types.js';
import { safeEqualBase64Url, sha256Base64Url } from '../security/random.js';

/** devices.json 的结构。 */
interface DevicesFile {
  version: 1;
  devices: DeviceRecord[];
}

/** 设备绑定存储；Mac 只保存令牌哈希。 */
export class DeviceStore {
  private readonly devicesFile: string;
  private records: DeviceRecord[];

  constructor(configDir: string) {
    this.devicesFile = resolveAgentPaths(configDir).devicesFile;
    this.records = readDevices(this.devicesFile);
  }

  /** 绑定设备并落盘，返回记录的副本。 */
  async create(
    deviceId: string,
    deviceName: string,
    tokenHash: string,
  ): Promise<DeviceRecord> {
    const record: DeviceRecord = {
      deviceId,
      deviceName,
      tokenHash,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.records = [...this.records, record];
    await this.persist();
    return { ...record };
  }

  /** 校验设备与令牌；错误令牌与未知设备都返回 null。 */
  async verify(deviceId: string, token: string): Promise<DeviceRecord | null> {
    const record = this.records.find(
      (entry) => entry.deviceId === deviceId && entry.revokedAt === null,
    );
    if (record === undefined) return null;
    if (!safeEqualBase64Url(sha256Base64Url(token), record.tokenHash)) {
      return null;
    }
    return { ...record };
  }

  /** 吊销设备并落盘；未知设备直接报错。 */
  async revoke(deviceId: string): Promise<DeviceRecord> {
    const index = this.records.findIndex((entry) => entry.deviceId === deviceId);
    const current = this.records[index];
    if (current === undefined) {
      throw new Error(`unknown device: ${deviceId}`);
    }
    const revoked: DeviceRecord = {
      ...current,
      revokedAt: new Date().toISOString(),
    };
    this.records = [
      ...this.records.slice(0, index),
      revoked,
      ...this.records.slice(index + 1),
    ];
    await this.persist();
    return { ...revoked };
  }

  /** 当前唯一有效设备；没有时返回 null。 */
  active(): DeviceRecord | null {
    const found = this.records.find((entry) => entry.revokedAt === null);
    return found === undefined ? null : { ...found };
  }

  /** 全部设备记录的副本，按创建顺序。 */
  list(): DeviceRecord[] {
    return this.records.map((entry) => ({ ...entry }));
  }

  private async persist(): Promise<void> {
    const file: DevicesFile = { version: 1, devices: this.records };
    await writeFileAtomic(
      this.devicesFile,
      `${JSON.stringify(file, null, 2)}\n`,
      CONFIG_FILE_MODE,
    );
  }
}

function readDevices(path: string): DeviceRecord[] {
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('devices.json must be a JSON object');
  }
  const devices = (parsed as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) {
    throw new Error('devices.json devices must be an array');
  }
  return devices as DeviceRecord[];
}