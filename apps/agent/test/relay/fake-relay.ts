import { AddressInfo } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

/** hello 处理行为；缺省回 ready。 */
export type HelloBehavior = (
  hello: Record<string, unknown>,
  socket: WebSocket,
  connectionIndex: number,
) => void;

/** 测试用 relay 桌面端点最小实现（契约 §5 子集）。 */
export interface FakeRelay {
  httpBase: string;
  connectCount(): number;
  authorizations(): Array<string | undefined>;
  received(): Array<Record<string, unknown>>;
  currentSocket(): WebSocket | null;
  send(message: Record<string, unknown>): void;
  closeSocket(code: number, reason?: string): void;
  waitForMessage(
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

export async function startFakeRelay(
  options: { onHello?: HelloBehavior; epoch?: number } = {},
): Promise<FakeRelay> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });
  const port = (wss.address() as AddressInfo).port;

  let connections = 0;
  let socket: WebSocket | null = null;
  const authHeaders: Array<string | undefined> = [];
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }> = [];

  const deliver = (message: Record<string, unknown>): void => {
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  };

  wss.on('connection', (connection, request) => {
    connections += 1;
    const index = connections;
    socket = connection;
    authHeaders.push(request.headers.authorization);
    connection.on('message', (data) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      deliver(parsed);
      if (parsed['type'] !== 'desktop.hello') return;
      if (options.onHello !== undefined) {
        options.onHello(parsed, connection, index);
        return;
      }
      const payload = parsed['payload'] as { handshakeId?: unknown };
      connection.send(
        JSON.stringify({
          type: 'desktop.ready',
          payload: {
            handshakeId:
              typeof payload.handshakeId === 'string' ? payload.handshakeId : '',
            contractVersion: 1,
            connectionEpoch: options.epoch ?? index,
          },
        }),
      );
    });
  });

  return {
    httpBase: `http://127.0.0.1:${port}`,
    connectCount: () => connections,
    authorizations: () => [...authHeaders],
    received: () => [...messages],
    currentSocket: () => socket,
    send(message) {
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        throw new Error('fake relay has no open socket');
      }
      socket.send(JSON.stringify(message));
    },
    closeSocket(code, reason = '') {
      socket?.close(code, reason);
    },
    waitForMessage(predicate, timeoutMs = 3000) {
      const existing = messages.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === wrapped);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('fake relay message timeout'));
        }, timeoutMs);
        const wrapped = (message: Record<string, unknown>): void => {
          clearTimeout(timer);
          resolve(message);
        };
        waiters.push({ predicate, resolve: wrapped });
      });
    },
    stop() {
      return new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      });
    },
  };
}