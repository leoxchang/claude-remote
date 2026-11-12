import { Command } from 'commander';

import { AgentSdkAdapter } from './adapter/agent-sdk-adapter.js';
import { AdminClient } from './admin/client.js';
import { createAgentRuntime } from './app/runtime.js';
import { DEFAULT_CONFIG_DIR, resolveAgentPaths } from './config/paths.js';
import { initializeConfig } from './config/initialize.js';
import { loadConfigV2 } from './config/config-v2.js';
import { renderPairingQr } from './pairing/qr.js';
import { toSummary } from './workspace/workspace-types.js';

/** 构造 Agent CLI；运行中管理操作统一走本机 Unix socket。 */
export function createCli(configDir: string = DEFAULT_CONFIG_DIR): Command {
  const program = new Command()
    .name('claude-remote-agent')
    .description('Claude Remote Mac agent')
    .showHelpAfterError();

  const adminClient = (): AdminClient =>
    new AdminClient(resolveAgentPaths(configDir).socketPath);

  program
    .command('init')
    .description('initialize the local configuration')
    .requiredOption('--workspace <path>', 'absolute path of the managed project')
    .requiredOption('--name <displayName>', 'display name shown on the phone')
    .requiredOption('--base-url <url>', 'https tailscale serve base url')
    .action(
      async (options: {
        workspace: string;
        name: string;
        baseUrl: string;
      }) => {
        const config = await initializeConfig({
          configDir,
          workspacePath: options.workspace,
          displayName: options.name,
          tailscaleBaseUrl: options.baseUrl,
        });
        process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      },
    );

  program
    .command('start')
    .description('start the agent in the foreground')
    .action(async () => {
      const config = await loadConfigV2(configDir);
      const runtime = await createAgentRuntime(config, new AgentSdkAdapter(), {
        configDir,
      });
      await runtime.start();
      process.stdout.write('agent started\n');
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await runtime.close();
    });

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

  const workspace = program
    .command('workspace')
    .description('manage locally authorized projects');

  workspace
    .command('add')
    .description('authorize a local project')
    .requiredOption('--path <absolutePath>', 'absolute project path')
    .requiredOption('--name <displayName>', 'display name shown on the phone')
    .action(async (options: { path: string; name: string }) => {
      const summary = await adminClient().workspaceAdd(
        options.path,
        options.name,
      );
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    });

  workspace
    .command('list')
    .description('list authorized projects from the local config')
    .action(async () => {
      const config = await loadConfigV2(configDir);
      process.stdout.write(
        `${JSON.stringify(config.workspaces.map(toSummary), null, 2)}\n`,
      );
    });

  workspace
    .command('rename')
    .description('rename an authorized project')
    .argument('<workspaceId>', 'workspace id to rename')
    .requiredOption('--name <displayName>', 'new display name')
    .action(async (workspaceId: string, options: { name: string }) => {
      const summary = await adminClient().workspaceRename(
        workspaceId,
        options.name,
      );
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    });

  workspace
    .command('remove')
    .description('remove a project authorization')
    .argument('<workspaceId>', 'workspace id to remove')
    .action(async (workspaceId: string) => {
      const result = await adminClient().workspaceRemove(workspaceId);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  return program;
}

/** 解析并执行 CLI，返回进程退出码。 */
export async function main(argv: readonly string[]): Promise<number> {
  await createCli().parseAsync([...argv]);
  return 0;
}