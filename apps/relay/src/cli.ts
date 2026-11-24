import { AddressInfo } from 'node:net';

import { Command } from 'commander';

import { AdminRequest, startAdminSocket } from './admin/admin-socket.js';
import { adminTokenFromEnv } from './admin/admin-http.js';
import { sendAdminRequest } from './admin/client.js';
import { createRelayApp } from './app.js';
import { loadConfig } from './config.js';
import { CLOSE_REVOKED } from './routing/desktop-link.js';
import { ConnectionRegistry } from './routing/registry.js';
import { openRelayStore } from './storage/sqlite-store.js';

/** CLI 入口：默认 serve，admin 子命令经 unix socket 操作运行中的 relay。 */
export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.name('claude-remote-relay').description('Claude Remote 云端中转');

  program
    .command('serve', { isDefault: true })
    .description('启动 relay 服务')
    .action(async () => {
      await serve();
    });

  const admin = program.command('admin').description('管理操作（需 relay 运行中）');

  admin
    .command('create-user <username>')
    .requiredOption('--password <password>')
    .description('创建账号')
    .action(async (username: string, options: { password: string }) => {
      await adminCall({
        op: 'create-user',
        username,
        password: options.password,
      });
    });

  admin
    .command('reset-password <username>')
    .requiredOption('--password <password>')
    .description('重置口令')
    .action(async (username: string, options: { password: string }) => {
      await adminCall({
        op: 'reset-password',
        username,
        password: options.password,
      });
    });

  admin
    .command('disable-user <username>')
    .description('禁用账号并断开其存活连接')
    .action(async (username: string) => {
      await adminCall({ op: 'disable-user', username });
    });

  admin
    .command('enable-user <username>')
    .description('启用账号')
    .action(async (username: string) => {
      await adminCall({ op: 'enable-user', username });
    });

  admin
    .command('list-accounts')
    .description('列出全部账号')
    .action(async () => {
      await adminCall({ op: 'list-accounts' });
    });

  admin
    .command('list-devices <username>')
    .description('列出账号名下设备')
    .action(async (username: string) => {
      await adminCall({ op: 'list-devices', username });
    });

  admin
    .command('revoke-device <deviceId>')
    .description('吊销设备并断开其存活连接')
    .action(async (deviceId: string) => {
      await adminCall({ op: 'revoke-device', deviceId });
    });

  await program.parseAsync(argv, { from: 'user' });
}

async function serve(): Promise<void> {
  const config = loadConfig(process.env);
  const store = openRelayStore(config.dataDir);
  const registry = new ConnectionRegistry();
  const adminToken = adminTokenFromEnv(process.env.RELAY_ADMIN_TOKEN);
  if (adminToken === undefined) {
    process.stderr.write(
      `${JSON.stringify({
        level: 'warn',
        msg: 'RELAY_ADMIN_TOKEN 未设置或长度不足 16，管理页未启用',
      })}\n`,
    );
  }
  const app = await createRelayApp({
    store,
    registry,
    logger: true,
    admin:
      adminToken === undefined
        ? undefined
        : {
            store,
            token: adminToken,
            onAccountDisabled: (accountId) => {
              registry.closeAccount(accountId, CLOSE_REVOKED);
            },
            onDeviceRevoked: (device) => {
              registry.closeDevice(device.deviceId, CLOSE_REVOKED);
            },
          },
  });
  await app.listen({ host: config.host, port: config.port });
  await startAdminSocket({
    store,
    dataDir: config.dataDir,
    onAccountDisabled: (accountId) => {
      registry.closeAccount(accountId, CLOSE_REVOKED);
    },
    onDeviceRevoked: (device) => {
      registry.closeDevice(device.deviceId, CLOSE_REVOKED);
    },
  });

  const address = app.server.address();
  const port = address === null ? config.port : (address as AddressInfo).port;
  process.stdout.write(
    `${JSON.stringify({ event: 'relay.started', host: config.host, port })}\n`,
  );
}

async function adminCall(request: AdminRequest): Promise<void> {
  const config = loadConfig(process.env);
  const response = await sendAdminRequest(config.dataDir, request);
  if (response.ok) {
    process.stdout.write(`${JSON.stringify(response.result ?? null)}\n`);
    return;
  }
  process.stderr.write(`${JSON.stringify(response)}\n`);
  process.exitCode = 1;
}