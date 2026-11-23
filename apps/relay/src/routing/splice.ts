import { RawData, WebSocket } from 'ws';
import { z } from 'zod';

import { RelayLimits } from '../limits.js';
import { DeviceRecord } from '../storage/store.js';
import { CLOSE_SLOW_CONSUMER } from './desktop-link.js';
import { PhoneLink } from './phone-link.js';
import { ConnectionRegistry, DesktopLink } from './registry.js';

/** 目标电脑离线/被取代时关闭手机连接的 code（契约 §4.2）。 */
export const CLOSE_DESKTOP_GONE = 4010;

const CLOSE_SUPERSEDED = 4000;
const FRAME_TOO_LARGE_REASON = 'frame too large';
const SLOW_CONSUMER_REASON = 'slow consumer';

const channelDataSchema = z.object({
  channelId: z.string().min(1),
  binary: z.boolean(),
  data: z.string(),
});

const MAX_CLOSE_REASON_BYTES = 123;
const CLOSE_NORMAL = 1000;
const CLOSE_INTERNAL_ERROR = 1011;
const RESERVED_NO_STATUS = 1005;
const RESERVED_ABNORMAL = 1006;
const RESERVED_NO_CODE = 1004;

/** 规范允许发送的关闭码：1000–1014（除 1004/1005/1006）或 3000–4999。 */
function isValidCloseCode(code: number): boolean {
  if (code === RESERVED_NO_CODE || code === RESERVED_NO_STATUS || code === RESERVED_ABNORMAL) {
    return false;
  }
  return (code >= 1000 && code <= 1014) || (code >= 3000 && code <= 4999);
}

/** 手机侧 close code 归一化：保留码不得透传给 Agent（契约 §5.2）。 */
function normalizeCloseCode(code: number): number {
  if (isValidCloseCode(code)) return code;
  if (code === RESERVED_ABNORMAL) return CLOSE_INTERNAL_ERROR;
  return CLOSE_NORMAL;
}

const channelCloseSchema = z.object({
  channelId: z.string().min(1),
  code: z.number().int().refine(isValidCloseCode),
  reason: z
    .string()
    .refine((reason) => Buffer.byteLength(reason, 'utf8') <= MAX_CLOSE_REASON_BYTES),
});

/** 契约 §5.2 channel.data 载荷。 */
export interface ChannelDataPayload {
  channelId: string;
  binary: boolean;
  data: string;
}

/** 手机通道接入依赖。 */
export interface PhoneChannelDeps {
  socket: WebSocket;
  device: DeviceRecord;
  desktopId: string;
  kind: 'control' | 'asr';
  registry: ConnectionRegistry;
  limits: RelayLimits;
}

/** 升级后建立通道：开通道、双向拼接、心跳与关闭联动。 */
export function acceptPhoneChannel(deps: PhoneChannelDeps): void {
  const desktop = deps.registry.desktopFor(deps.desktopId);
  if (desktop === undefined) {
    deps.socket.close(CLOSE_DESKTOP_GONE, 'desktop gone');
    return;
  }
  const link = deps.registry.attachPhone(
    deps.device,
    deps.desktopId,
    deps.kind,
    deps.socket,
  );
  // 升级与登记之间桌面可能被取代：此时通道归旧链路，立即关闭。
  if (deps.registry.desktopFor(deps.desktopId) !== desktop) {
    deps.socket.close(CLOSE_DESKTOP_GONE, 'desktop gone');
    return;
  }
  desktop.channels.set(link.channelId, link);
  desktop.send({
    type: 'channel.open',
    payload: {
      channelId: link.channelId,
      kind: link.kind,
      deviceId: link.deviceId,
      appVersion: deps.device.appVersion,
    },
  });

  // 手机链路心跳（契约 §2.1/§4.2）：15s ping / 45s 无 pong 断开（测试可覆盖）。
  let lastPongAt = Date.now();
  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastPongAt > deps.limits.pongTimeoutMs) {
      deps.socket.terminate();
      return;
    }
    deps.socket.ping();
  }, deps.limits.pingIntervalMs);
  deps.socket.on('pong', () => {
    lastPongAt = Date.now();
  });

  deps.socket.on('message', (data: RawData, isBinary: boolean) => {
    const target = deps.registry.desktopFor(deps.desktopId);
    if (target === undefined) {
      deps.socket.close(CLOSE_DESKTOP_GONE, 'desktop gone');
      return;
    }
    splicePhoneToDesktop(link, target, toBuffer(data), isBinary, deps.limits);
  });
  deps.socket.on('close', (code: number, reason: Buffer) => {
    clearInterval(heartbeatTimer);
    deps.registry.detachPhone(link);
    const target = deps.registry.desktopFor(deps.desktopId);
    // 仅当通道仍登记在该桌面连接上才通知；被取代清空的旧通道不发伪造 channel.close。
    if (target !== undefined && target.channels.get(link.channelId) === link) {
      target.channels.delete(link.channelId);
      target.send({
        type: 'channel.close',
        payload: {
          channelId: link.channelId,
          code: normalizeCloseCode(code),
          reason: reason.toString('utf8'),
        },
      });
    }
  });
  deps.socket.on('error', () => {
    deps.socket.terminate();
  });
}

/**
 * 手机 → 桌面：帧原样封装（文本直传、二进制 base64）。
 * 大小按解码后 UTF-8 字节数判定；control 通道拒收二进制帧。
 */
export function splicePhoneToDesktop(
  link: PhoneLink,
  desktop: DesktopLink,
  data: Buffer,
  isBinary: boolean,
  limits: RelayLimits,
): void {
  if (link.kind === 'control' && isBinary) {
    link.socket.close(CLOSE_SLOW_CONSUMER, FRAME_TOO_LARGE_REASON);
    return;
  }
  const limit =
    link.kind === 'control' ? limits.controlFrameBytes : limits.asrFrameBytes;
  if (data.byteLength > limit) {
    link.socket.close(CLOSE_SLOW_CONSUMER, FRAME_TOO_LARGE_REASON);
    return;
  }
  // 背压（契约 §5.3）：桌面缓冲未清时按通道累计待发字节，
  // 超通道上限或桌面总缓冲超限时关闭该通道（4003），而非无限缓冲。
  const desktopBuffered = desktop.socket.bufferedAmount;
  if (desktopBuffered > limits.desktopBufferBytes) {
    link.socket.close(CLOSE_SLOW_CONSUMER, SLOW_CONSUMER_REASON);
    return;
  }
  if (desktopBuffered > 0) {
    link.pendingBytes += data.byteLength;
    if (link.pendingBytes > limits.channelBufferBytes) {
      link.socket.close(CLOSE_SLOW_CONSUMER, SLOW_CONSUMER_REASON);
      return;
    }
  } else {
    link.pendingBytes = 0;
  }
  desktop.send({
    type: 'channel.data',
    payload: isBinary
      ? {
          channelId: link.channelId,
          binary: true,
          data: data.toString('base64'),
        }
      : { channelId: link.channelId, binary: false, data: data.toString('utf8') },
  });
}

/** 桌面 → 手机：base64 解码回二进制帧，文本原样；与上行共用帧上限。 */
export function spliceDesktopToPhone(
  link: PhoneLink,
  payload: ChannelDataPayload,
  limits: RelayLimits,
): void {
  const limit =
    link.kind === 'control' ? limits.controlFrameBytes : limits.asrFrameBytes;
  if (link.socket.bufferedAmount > limits.channelBufferBytes) {
    link.socket.close(CLOSE_SLOW_CONSUMER, SLOW_CONSUMER_REASON);
    return;
  }
  if (payload.binary) {
    const data = Buffer.from(payload.data, 'base64');
    if (data.byteLength > limit) {
      link.socket.close(CLOSE_SLOW_CONSUMER, FRAME_TOO_LARGE_REASON);
      return;
    }
    link.socket.send(data, { binary: true });
    return;
  }
  if (Buffer.byteLength(payload.data, 'utf8') > limit) {
    link.socket.close(CLOSE_SLOW_CONSUMER, FRAME_TOO_LARGE_REASON);
    return;
  }
  link.socket.send(payload.data);
}

/**
 * 处理握手后的桌面入站消息；返回 true 表示已处理。
 * channel.data 发往未知/已关闭通道时忽略。
 */
export function handleDesktopMessage(
  registry: ConnectionRegistry,
  desktop: DesktopLink,
  text: string,
  limits: RelayLimits,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const message = parsed as { type?: unknown; payload?: unknown };

  if (message.type === 'channel.data') {
    const payload = channelDataSchema.safeParse(message.payload);
    if (!payload.success) return false;
    const link = desktop.channels.get(payload.data.channelId);
    if (link !== undefined) spliceDesktopToPhone(link, payload.data, limits);
    return true;
  }
  if (message.type === 'channel.close') {
    const payload = channelCloseSchema.safeParse(message.payload);
    if (!payload.success) return false;
    const link = desktop.channels.get(payload.data.channelId);
    if (link !== undefined) {
      desktop.channels.delete(payload.data.channelId);
      registry.detachPhone(link);
      link.socket.close(payload.data.code, payload.data.reason);
    }
    return true;
  }
  return false;
}

/** 桌面连接断开/被取代时关闭其全部手机通道（4010）。 */
export function closeDesktopChannels(
  registry: ConnectionRegistry,
  desktop: DesktopLink,
): void {
  for (const link of [...desktop.channels.values()]) {
    registry.detachPhone(link);
    link.socket.close(CLOSE_DESKTOP_GONE, 'desktop gone');
  }
  desktop.channels.clear();
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}