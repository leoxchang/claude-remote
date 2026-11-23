import { WebSocket } from 'ws';

import { newPrefixedId } from '../security/credentials.js';
import { DeviceRecord } from '../storage/store.js';
import { PhoneLink } from './phone-link.js';

/** 云端发给桌面连接的出站消息信封。 */
export interface DesktopOutboundMessage {
  type: string;
  payload: Record<string, unknown>;
}

/** 一条存活的桌面连接；channels 为该电脑承载的手机通道。 */
export interface DesktopLink {
  desktopId: string;
  accountId: string;
  epoch: number;
  socket: WebSocket;
  channels: Map<string, PhoneLink>;
  send(message: DesktopOutboundMessage): void;
}

/** 内存连接表：按 desktopId 路由，新连接取代旧连接。 */
export class ConnectionRegistry {
  private readonly desktops = new Map<string, DesktopLink>();
  private readonly phones = new Map<string, PhoneLink>();

  /** 挂载手机通道；同 (deviceId, kind) 旧连接立即以 4000 关闭，不同种类互不影响。 */
  attachPhone(
    device: DeviceRecord,
    desktopId: string,
    kind: 'control' | 'asr',
    socket: WebSocket,
  ): PhoneLink {
    const link: PhoneLink = {
      channelId: newPrefixedId('ch_'),
      deviceId: device.deviceId,
      accountId: device.accountId,
      desktopId,
      kind,
      socket,
      pendingBytes: 0,
    };
    const key = phoneKey(device.deviceId, kind);
    const previous = this.phones.get(key);
    this.phones.set(key, link);
    if (previous !== undefined) {
      previous.socket.close(4000, 'superseded');
    }
    return link;
  }

  /** 仅当仍是当前通道时移除。 */
  detachPhone(link: PhoneLink): void {
    const key = phoneKey(link.deviceId, link.kind);
    if (this.phones.get(key) === link) this.phones.delete(key);
  }

  /** 挂载桌面连接；同 desktopId 旧连接立即以 4000 关闭。 */
  attachDesktop(
    device: DeviceRecord,
    socket: WebSocket,
    epoch: number,
  ): DesktopLink {
    const link: DesktopLink = {
      desktopId: device.deviceId,
      accountId: device.accountId,
      epoch,
      socket,
      channels: new Map(),
      send: (message) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
    };
    const previous = this.desktops.get(device.deviceId);
    this.desktops.set(device.deviceId, link);
    if (previous !== undefined) {
      previous.socket.close(4000, 'superseded');
    }
    return link;
  }

  /** 仅当仍是当前连接时移除（被取代的旧连接清理时不误删新连接）。 */
  detachDesktop(link: DesktopLink): void {
    if (this.desktops.get(link.desktopId) === link) {
      this.desktops.delete(link.desktopId);
    }
  }

  desktopFor(desktopId: string): DesktopLink | undefined {
    return this.desktops.get(desktopId);
  }

  isOnline(desktopId: string): boolean {
    const link = this.desktops.get(desktopId);
    return link !== undefined && link.socket.readyState === WebSocket.OPEN;
  }

  /** 吊销/禁用联动：关闭该设备的桌面连接与其全部手机通道。 */
  closeDevice(deviceId: string, code: number): void {
    const desktop = this.desktops.get(deviceId);
    if (desktop !== undefined) {
      this.desktops.delete(deviceId);
      desktop.socket.close(code, 'closed');
    }
    for (const [key, link] of [...this.phones.entries()]) {
      if (link.deviceId !== deviceId) continue;
      this.phones.delete(key);
      link.socket.close(code, 'closed');
    }
  }

  /** 吊销/禁用联动：关闭该账号全部桌面连接与手机通道。 */
  closeAccount(accountId: string, code: number): void {
    for (const link of [...this.desktops.values()]) {
      if (link.accountId !== accountId) continue;
      this.desktops.delete(link.desktopId);
      link.socket.close(code, 'closed');
    }
    for (const [key, link] of [...this.phones.entries()]) {
      if (link.accountId !== accountId) continue;
      this.phones.delete(key);
      link.socket.close(code, 'closed');
    }
  }
}

function phoneKey(deviceId: string, kind: 'control' | 'asr'): string {
  return `${deviceId}:${kind}`;
}