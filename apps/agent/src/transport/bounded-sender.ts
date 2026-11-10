import { ProtocolMessage } from '@claude-remote/protocol/types';

/** 发送结果：直接写出、进入队列、或连接已关闭。 */
export type SendResult = 'sent' | 'queued' | 'closed';

/** 每连接发送队列的默认字节上限。 */
export const MAX_QUEUE_BYTES = 2 * 1024 * 1024;

/** 每连接发送队列的默认消息条数上限。 */
export const MAX_QUEUE_MESSAGES = 1000;

/** 写出函数：返回 false 表示 socket 暂时不接受数据。 */
export type MessageWriter = (data: string) => boolean;

/**
 * 有界发送队列。超出预算时先请求上游合并/降频，仍超限则关闭连接。
 * 只缓存序列化后的协议消息，不参与事件合并。
 */
export class BoundedSender {
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private queuedMessages = 0;
  private closed = false;
  private writer: MessageWriter | null = null;

  constructor(
    private readonly onPressure: () => void,
    private readonly maxBytes: number = MAX_QUEUE_BYTES,
    private readonly maxMessages: number = MAX_QUEUE_MESSAGES,
  ) {}

  /** 绑定写出函数并立刻尝试排空队列。 */
  attach(writer: MessageWriter): void {
    this.writer = writer;
    this.drain();
  }

  /** 发送一条协议消息。 */
  send(message: ProtocolMessage): SendResult {
    if (this.closed) return 'closed';
    const data = JSON.stringify(message);
    const bytes = Buffer.byteLength(data, 'utf8');
    if (!this.fits(bytes)) {
      this.onPressure();
      this.drain();
      if (!this.fits(bytes)) {
        this.close();
        return 'closed';
      }
    }
    this.queue.push(data);
    this.queuedBytes += bytes;
    this.queuedMessages += 1;
    this.drain();
    return this.queue.length > 0 ? 'queued' : 'sent';
  }

  /** 关闭队列；之后所有发送都返回 closed。 */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.queuedMessages = 0;
  }

  private fits(bytes: number): boolean {
    return (
      this.queuedBytes + bytes <= this.maxBytes &&
      this.queuedMessages + 1 <= this.maxMessages
    );
  }

  private drain(): void {
    if (this.writer === null) return;
    while (this.queue.length > 0) {
      const data = this.queue[0];
      if (data === undefined) return;
      if (!this.writer(data)) return;
      this.queue.shift();
      this.queuedBytes -= Buffer.byteLength(data, 'utf8');
      this.queuedMessages -= 1;
    }
  }
}