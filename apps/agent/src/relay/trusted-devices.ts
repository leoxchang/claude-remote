/** 信任设备叠加：本地已配对设备 ∪ 当前经 relay 存活的云端手机。 */
export interface TrustedDevices {
  activate(deviceId: string): void;
  deactivate(deviceId: string): void;
  isActive(deviceId: string): boolean;
}

/**
 * 云端手机不进本地 device store；这里维护其存活集合。
 * 关闭通道时 deactivate，释放后立即回落本地判定。
 */
export function createTrustedDevices(
  isLocallyActive: (deviceId: string) => boolean,
): TrustedDevices {
  const relayActive = new Set<string>();
  return {
    activate(deviceId) {
      relayActive.add(deviceId);
    },
    deactivate(deviceId) {
      relayActive.delete(deviceId);
    },
    isActive(deviceId) {
      return relayActive.has(deviceId) || isLocallyActive(deviceId);
    },
  };
}