import { chmodSync, rmSync } from 'node:fs';
import { createServer, Server, Socket } from 'node:net';
import { join } from 'node:path';

import { z } from 'zod';

import { DeviceRecord, RelayStore, StoreError } from '../storage/store.js';

/** admin unix socket 文件名；位于 data 目录下。 */
export const ADMIN_SOCKET_FILE = 'relay-admin.sock';

const SOCKET_MODE = 0o600;
/** 创建 socket 期间收紧 umask，消除 chmod 之前的权限窗口（TOCTOU）。 */
const UMASK_OWNER_ONLY = 0o177;
const MAX_REQUEST_BYTES = 64 * 1024;
const LINE_SEPARATOR = '\n';

/** 管理操作的核心依赖；socket 与 HTTP 入口共用。 */
export interface AdminCoreDeps {
  store: RelayStore;
  onAccountDisabled?(accountId: string): void;
  onDeviceRevoked?(device: DeviceRecord): void;
}

/** admin socket 依赖；回调由即时断开接线使用。 */
export interface AdminDeps extends AdminCoreDeps {
  dataDir: string;
}

const requestSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create-user'),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({
    op: z.literal('reset-password'),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({ op: z.literal('disable-user'), username: z.string().min(1) }),
  z.object({ op: z.literal('enable-user'), username: z.string().min(1) }),
  z.object({ op: z.literal('list-accounts') }),
  z.object({ op: z.literal('list-devices'), username: z.string().min(1) }),
  z.object({ op: z.literal('revoke-device'), deviceId: z.string().min(1) }),
]);

/** 管理请求；每连接一条 JSON，换行结束。 */
export type AdminRequest = z.infer<typeof requestSchema>;

/** 管理响应；未知 op 与畸形请求一律 INVALID_REQUEST。 */
export type AdminResponse =
  | { ok: true; result?: unknown }
  | { ok: false; error: { code: string; message: string } };

/** 启动 admin socket；启动前清理残留 socket 文件，权限 0600。 */
export async function startAdminSocket(deps: AdminDeps): Promise<Server> {
  const socketPath = join(deps.dataDir, ADMIN_SOCKET_FILE);
  rmSync(socketPath, { force: true });
  const server = createServer((socket) => {
    handleConnection(deps, socket);
  });
  const previousUmask = process.umask(UMASK_OWNER_ONLY);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(previousUmask);
  }
  chmodSync(socketPath, SOCKET_MODE);
  return server;
}

function handleConnection(deps: AdminDeps, socket: Socket): void {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > MAX_REQUEST_BYTES) {
      socket.destroy();
      return;
    }
    const separator = buffer.indexOf(LINE_SEPARATOR);
    if (separator === -1) return;
    const line = buffer.slice(0, separator);
    socket.removeAllListeners('data');
    const response = handleRequest(deps, line);
    socket.end(`${JSON.stringify(response)}${LINE_SEPARATOR}`);
  });
}

function handleRequest(deps: AdminCoreDeps, line: string): AdminResponse {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(line);
  } catch {
    return failure('INVALID_REQUEST');
  }
  return handleAdminRequest(deps, parsedJson);
}

/** 管理请求的核心处理；socket 与 HTTP 入口共用，错误码即 CLI 语义。 */
export function handleAdminRequest(
  deps: AdminCoreDeps,
  input: unknown,
): AdminResponse {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return failure('INVALID_REQUEST');
  const request = parsed.data;
  try {
    switch (request.op) {
      case 'create-user':
        return {
          ok: true,
          result: deps.store.createAccount(request.username, request.password),
        };
      case 'reset-password':
        deps.store.setPassword(request.username, request.password);
        return { ok: true };
      case 'disable-user':
        return setDisabled(deps, request.username, true);
      case 'enable-user':
        return setDisabled(deps, request.username, false);
      case 'list-accounts':
        return { ok: true, result: deps.store.listAccounts() };
      case 'list-devices': {
        const account = deps.store.findAccountByUsername(request.username);
        if (account === null) return failure('ACCOUNT_NOT_FOUND');
        return { ok: true, result: deps.store.listDevices(account.accountId) };
      }
      case 'revoke-device': {
        const device = deps.store.findDevice(request.deviceId);
        if (device === null) return failure('DEVICE_NOT_FOUND');
        if (deps.store.revokeDevice(device.accountId, device.deviceId)) {
          deps.onDeviceRevoked?.(device);
          return { ok: true };
        }
        return failure('DEVICE_NOT_FOUND');
      }
      default:
        return failure('INVALID_REQUEST');
    }
  } catch (error: unknown) {
    if (error instanceof StoreError) return failure(error.code);
    throw error;
  }
}

function setDisabled(
  deps: AdminCoreDeps,
  username: string,
  disabled: boolean,
): AdminResponse {
  const account = deps.store.findAccountByUsername(username);
  if (account === null) return failure('ACCOUNT_NOT_FOUND');
  deps.store.setAccountDisabled(username, disabled);
  if (disabled) deps.onAccountDisabled?.(account.accountId);
  return { ok: true };
}

function failure(code: string): AdminResponse {
  return { ok: false, error: { code, message: code } };
}