/** S00 只支持协议 V1。 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

/** App 在认证连接上发送的握手载荷。 */
export interface ConnectionHelloPayload {
  supportedProtocolVersions: number[];
  appVersion: string;
  deviceId: string;
  capabilities: string[];
  /** 随机握手 ID，只用于关联日志；ready 必须原样回显。 */
  handshakeId: string;
}

/** 握手结果：不兼容时不返回版本号，调用方无法继续创建 run。 */
export type HandshakeResult =
  | { accepted: true; protocolVersion: 1 }
  | { accepted: false; error: { code: 'VERSION_INCOMPATIBLE' } };

/** 选择双方都支持的协议版本。 */
export function negotiateProtocolVersion(
  hello: ConnectionHelloPayload,
): HandshakeResult {
  if (hello.supportedProtocolVersions.includes(1)) {
    return { accepted: true, protocolVersion: 1 };
  }
  return { accepted: false, error: { code: 'VERSION_INCOMPATIBLE' } };
}