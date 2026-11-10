import { Command } from 'commander';

import { AdminClient } from './admin/client.js';
import { DEFAULT_CONFIG_DIR, resolveAgentPaths } from './config/paths.js';
import { renderPairingQr } from './pairing/qr.js';

/** 构造 Agent CLI；运行中管理操作统一走本机 Unix socket。 */
export function createCli(configDir: string = DEFAULT_CONFIG_DIR): Command {
  const program = new Command()
    .name('claude-remote-agent')
    .description('Claude Remote Mac agent')
    .showHelpAfterError();

  const adminClient = (): AdminClient =>
    new AdminClient(resolveAgentPaths(configDir).socketPath);

  program
    .command('status')
    .description('show the running agent status')
    .action(async () => {
      const status = await adminClient().status();
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    });

  program
    .command('devices')
    .description('list bound devices')
    .action(async () => {
      const devices = await adminClient().devices();
      process.stdout.write(`${JSON.stringify(devices, null, 2)}\n`);
    });

  program
    .command('pair')
    .description('show a one-time pairing qr code')
    .option('--replace', 'replace the currently bound device')
    .action(async (options: { replace?: boolean }) => {
      const payload = await adminClient().pair(options.replace === true);
      process.stdout.write(`${await renderPairingQr(payload)}\n`);
      process.stdout.write(
        `expiresAt: ${new Date(payload.expiresAt).toISOString()}\n`,
      );
    });

  program
    .command('revoke')
    .description('revoke a bound device')
    .argument('<deviceId>', 'device id to revoke')
    .action(async (deviceId: string) => {
      const record = await adminClient().revoke(deviceId);
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    });

  return program;
}

/** 解析并执行 CLI，返回进程退出码。 */
export async function main(argv: readonly string[]): Promise<number> {
  await createCli().parseAsync([...argv]);
  return 0;
}