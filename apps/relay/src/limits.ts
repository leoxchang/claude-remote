/** 契约 §2.1/§5.3 规定的全部上限与超时；可经 createRelayApp 覆盖（仅测试）。 */
export interface RelayLimits {
  loginPerMinute: number;
  maxDevicesPerAccount: number;
  controlFrameBytes: number;
  asrFrameBytes: number;
  httpBodyBytes: number;
  desktopMessageBytes: number;
  httpTimeoutMs: number;
  handshakeTimeoutMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  channelBufferBytes: number;
  desktopBufferBytes: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  loginPerMinute: 10,
  maxDevicesPerAccount: 20,
  controlFrameBytes: 65536,
  asrFrameBytes: 262144,
  httpBodyBytes: 12582912,
  /** 须容纳 12 MiB 代答体 base64 后的 16 MiB 与信封余量（契约 §2.1）。 */
  desktopMessageBytes: 20971520,
  httpTimeoutMs: 30000,
  handshakeTimeoutMs: 10000,
  pingIntervalMs: 15000,
  pongTimeoutMs: 45000,
  channelBufferBytes: 2097152,
  desktopBufferBytes: 8388608,
};