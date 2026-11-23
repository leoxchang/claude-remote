import { WebSocket } from 'ws';

/** 手机通道在桌面连接上的逻辑映射；Task 7 起由 /ws 与 /ws/asr 填充。 */
export interface PhoneLink {
  channelId: string;
  deviceId: string;
  accountId: string;
  desktopId: string;
  kind: 'control' | 'asr';
  socket: WebSocket;
  pendingBytes: number;
}