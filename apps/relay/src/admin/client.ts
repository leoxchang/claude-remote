import { connect } from 'node:net';
import { join } from 'node:path';

import {
  ADMIN_SOCKET_FILE,
  AdminRequest,
  AdminResponse,
} from './admin-socket.js';

const LINE_SEPARATOR = '\n';

/** 经 unix socket 发送一条管理请求；relay 未运行时返回 ADMIN_UNAVAILABLE。 */
export function sendAdminRequest(
  dataDir: string,
  request: AdminRequest,
): Promise<AdminResponse> {
  return new Promise((resolve) => {
    const socket = connect(join(dataDir, ADMIN_SOCKET_FILE));
    let buffer = '';
    let settled = false;
    const settle = (response: AdminResponse): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const fail = (code: string): void =>
      settle({ ok: false, error: { code, message: code } });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
    });
    socket.on('end', () => {
      try {
        settle(JSON.parse(buffer.trim()) as AdminResponse);
      } catch {
        fail('INVALID_RESPONSE');
      }
    });
    socket.on('error', () => fail('ADMIN_UNAVAILABLE'));
    socket.write(`${JSON.stringify(request)}${LINE_SEPARATOR}`);
  });
}