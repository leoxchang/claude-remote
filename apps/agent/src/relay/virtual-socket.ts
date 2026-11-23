/** 与 ws 常量同值的 readyState；ConnectionManager 按数字比较。 */
export const VIRTUAL_SOCKET_OPEN = 1;
export const VIRTUAL_SOCKET_CLOSING = 2;
export const VIRTUAL_SOCKET_CLOSED = 3;

const CODE_ABNORMAL = 1006;

/** 通道出站出口；由 relay connector 接到 RelayLink。 */
export interface VirtualSocketTransport {
  sendText(data: string): void;
  sendBinary(data: Uint8Array): void;
  sendClose(code: number, reason: string): void;
}

type Listener = (...args: unknown[]) => void;

/**
 * 云端手机通道的 ws 兼容子集：
 * 满足 ConnectionManager/AsrGateway 对 socket 的使用面，
 * 出入站经 transport 接到 relay 的 channel.data/channel.close。
 */
export class VirtualPhoneSocket {
  readyState = VIRTUAL_SOCKET_OPEN;
  /** 发送交给 relay 缓冲，本地恒 0。 */
  readonly bufferedAmount = 0;

  private readonly listeners = new Map<string, Listener[]>();

  constructor(private readonly transport: VirtualSocketTransport) {}

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== VIRTUAL_SOCKET_OPEN) return;
    if (typeof data === 'string') {
      this.transport.sendText(data);
      return;
    }
    this.transport.sendBinary(data);
  }

  /** ConnectionManager 心跳：本地即时应答 pong，不经过 relay。 */
  ping(): void {
    queueMicrotask(() => {
      this.emit('pong');
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState !== VIRTUAL_SOCKET_OPEN) return;
    this.readyState = VIRTUAL_SOCKET_CLOSING;
    this.transport.sendClose(code, reason);
    this.finalize(code, reason);
  }

  terminate(): void {
    if (!this.finalize(CODE_ABNORMAL, 'terminated')) return;
  }

  /** relay 下行 channel.data → 本连接 message 事件。 */
  receive(data: string | Buffer, isBinary: boolean): void {
    if (this.readyState === VIRTUAL_SOCKET_CLOSED) return;
    this.emit('message', data, isBinary);
  }

  /** relay 上行 channel.close → 本连接关闭，不再外发。 */
  remoteClose(code: number, reason: string): void {
    this.finalize(code, reason);
  }

  private finalize(code: number, reason: string): boolean {
    if (this.readyState === VIRTUAL_SOCKET_CLOSED) return false;
    this.readyState = VIRTUAL_SOCKET_CLOSED;
    this.emit('close', code, reason);
    return true;
  }

  private emit(event: string, ...args: unknown[]): void {
    const listeners = [...(this.listeners.get(event) ?? [])];
    for (const listener of listeners) {
      listener(...args);
    }
  }
}