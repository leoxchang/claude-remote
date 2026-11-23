import { Buffer } from 'node:buffer';

import { AGENT_VERSION } from '../app/versions.js';
import { AgentLogger } from '../app/logger.js';
import { GatewaySocket } from '../asr/asr-gateway.js';
import { AgentConfigV5 } from '../config/config-v5.js';
import { DeviceRecord } from '../domain/types.js';
import { ConnectionManager } from '../transport/connection-manager.js';
import {
  RelayLink,
  RelayLinkHandlers,
  RelayLinkState,
  startRelayLink,
} from './link.js';
import { TrustedDevices } from './trusted-devices.js';
import { VirtualPhoneSocket } from './virtual-socket.js';

const INTERNAL_ERROR_BODY = JSON.stringify({
  error: { code: 'INTERNAL_ERROR', message: 'INTERNAL_ERROR' },
});
const LINK_DOWN_CODE = 1006;

/** relay http.request 分发输入。 */
export interface RelayHttpDispatchRequest {
  deviceId: string;
  method: string;
  path: string;
  contentType?: string;
  /** 转发自手机 URL 的查询参数（不含 desktopId）。 */
  query?: Record<string, string>;
  body: Buffer;
}

/** 分发结果；connector 编码为 http.response。 */
export interface RelayHttpDispatchResult {
  status: number;
  contentType: string;
  body: Buffer;
}

/** 代答分发函数（Task 8 提供真实实现；此前为 404 占位）。 */
export type RelayHttpDispatch = (
  request: RelayHttpDispatchRequest,
) => RelayHttpDispatchResult;

export type RelayConnectorState = RelayLinkState;

/** connector 依赖。 */
export interface RelayConnectorOptions {
  connections: ConnectionManager;
  relayDevices: TrustedDevices;
  asrAccept: (socket: GatewaySocket, deviceId: string) => void;
  httpDispatch: RelayHttpDispatch;
  logger: AgentLogger;
}

/** 连接层：持有 handler 集合与通道映射。 */
export interface RelayConnector {
  readonly handlers: RelayLinkHandlers;
  /** 绑定出站链路；虚拟 socket 的发送经此回发 relay。 */
  attachLink(link: RelayLink): void;
  /** 链路断开/停机时关闭全部虚拟通道并回收信任设备。 */
  closeAll(code: number, reason: string): void;
}

interface ChannelEntry {
  socket: VirtualPhoneSocket;
  deviceId: string;
}

/** 合成云端设备的本地记录；命令路由与通道注入共用，避免两处漂移。 */
export function relayDeviceRecord(deviceId: string): DeviceRecord {
  return {
    deviceId,
    deviceName: `relay:${deviceId}`,
    tokenHash: '',
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
}

/** 把 relay 通道映射到 ConnectionManager / AsrGateway。 */
export function createRelayConnector(
  options: RelayConnectorOptions,
): RelayConnector {
  const { logger } = options;
  const channels = new Map<string, ChannelEntry>();
  const deviceChannelCounts = new Map<string, number>();
  let link: RelayLink | null = null;

  const activateDevice = (deviceId: string): void => {
    const count = (deviceChannelCounts.get(deviceId) ?? 0) + 1;
    deviceChannelCounts.set(deviceId, count);
    options.relayDevices.activate(deviceId);
  };
  const releaseDevice = (deviceId: string): void => {
    const count = (deviceChannelCounts.get(deviceId) ?? 0) - 1;
    if (count <= 0) {
      deviceChannelCounts.delete(deviceId);
      options.relayDevices.deactivate(deviceId);
      return;
    }
    deviceChannelCounts.set(deviceId, count);
  };

  const handlers: RelayLinkHandlers = {
    onReady: (info) => {
      logger.info('relay.ready', { epoch: info.epoch });
    },
    onChannelOpen: (input) => {
      if (channels.has(input.channelId)) {
        logger.warn('relay.duplicate_channel', { channelId: input.channelId });
        return;
      }
      const channelId = input.channelId;
      const socket = new VirtualPhoneSocket({
        sendText: (data) => link?.channelData(channelId, data),
        sendBinary: (data) => link?.channelData(channelId, data),
        sendClose: (code, reason) => link?.channelClose(channelId, code, reason),
      });
      socket.on('close', () => {
        channels.delete(channelId);
        releaseDevice(input.deviceId);
      });
      channels.set(channelId, { socket, deviceId: input.deviceId });
      activateDevice(input.deviceId);

      if (input.kind === 'control') {
        void options.connections.accept(
          socket as unknown as Parameters<ConnectionManager['accept']>[0],
          relayDeviceRecord(input.deviceId),
        );
        return;
      }
      options.asrAccept(socket as unknown as GatewaySocket, input.deviceId);
    },
    onChannelData: (input) => {
      const entry = channels.get(input.channelId);
      if (entry === undefined) {
        logger.warn('relay.unknown_channel', { channelId: input.channelId });
        return;
      }
      entry.socket.receive(
        input.binary ? Buffer.from(input.data, 'base64') : input.data,
        input.binary,
      );
    },
    onChannelClose: (input) => {
      closeChannel(input.channelId, input.code, input.reason);
    },
    onHttpRequest: (input) => {
      try {
        const result = options.httpDispatch({
          deviceId: input.deviceId,
          method: input.method,
          path: input.path,
          ...(input.contentType === undefined
            ? {}
            : { contentType: input.contentType }),
          ...(input.query === undefined ? {} : { query: input.query }),
          body: input.body,
        });
        link?.httpResponse(input.requestId, result);
      } catch (error: unknown) {
        logger.warn('relay.http_dispatch_failed', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        link?.httpResponse(input.requestId, {
          status: 500,
          contentType: 'application/json',
          body: Buffer.from(INTERNAL_ERROR_BODY),
        });
      }
    },
    onDisconnected: () => {
      connector.closeAll(LINK_DOWN_CODE, 'link down');
    },
  };

  function closeChannel(channelId: string, code: number, reason: string): void {
    const entry = channels.get(channelId);
    if (entry === undefined) return;
    channels.delete(channelId);
    // 只触发 socket 关闭；引用计数的释放统一由 socket 的 close 监听器完成
    // （remoteClose 会同步触发监听器，这里不得重复 release）。
    entry.socket.remoteClose(code, reason);
  }

  const connector: RelayConnector = {
    handlers,
    attachLink(createdLink) {
      link = createdLink;
    },
    closeAll(code, reason) {
      for (const [channelId, entry] of [...channels.entries()]) {
        channels.delete(channelId);
        entry.socket.remoteClose(code, reason);
      }
      for (const deviceId of [...deviceChannelCounts.keys()]) {
        options.relayDevices.deactivate(deviceId);
      }
      deviceChannelCounts.clear();
    },
  };

  return connector;
}

/** 从配置启动 relay 链路；config.relay 缺省返回 null。 */
export function startRelayFromConfig(options: {
  config: AgentConfigV5;
  connections: ConnectionManager;
  relayDevices: TrustedDevices;
  asrAccept: (socket: GatewaySocket, deviceId: string) => void;
  httpDispatch: RelayHttpDispatch;
  logger: AgentLogger;
}): { link: RelayLink; connector: RelayConnector } | null {
  const relay = options.config.relay;
  if (relay === undefined) return null;
  const connector = createRelayConnector({
    connections: options.connections,
    relayDevices: options.relayDevices,
    asrAccept: options.asrAccept,
    httpDispatch: options.httpDispatch,
    logger: options.logger,
  });
  const link = startRelayLink({
    baseUrl: relay.baseUrl,
    credential: {
      deviceId: relay.deviceId,
      deviceToken: relay.deviceToken,
    },
    hello: {
      appVersion: AGENT_VERSION,
      desktopName: relay.desktopName,
      platform: 'macos',
      supportedContractVersions: [1],
    },
    handlers: connector.handlers,
    logger: options.logger,
  });
  connector.attachLink(link);
  return { link, connector };
}