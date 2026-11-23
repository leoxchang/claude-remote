import { join } from 'node:path';

import { Command } from 'commander';

import { AgentSdkAdapter } from './adapter/agent-sdk-adapter.js';
import { AttachmentStore } from './attachment/attachment-store.js';
import { AdminClient } from './admin/client.js';
import { createDurableAgentRuntime } from './app/runtime.js';
import {
  AGENT_LISTEN_PORT,
  DEFAULT_CONFIG_DIR,
  resolveAgentPaths,
} from './config/paths.js';
import { initializeConfig } from './config/initialize.js';
import { detectLanAddress, disableLan, enableLan, lanStatus } from './config/lan.js';
import { buildDiagnostics, writeDiagnostics } from './diagnostics/export.js';
import { runDoctor } from './diagnostics/doctor.js';
import { renderPairingQr } from './pairing/qr.js';
import { readConfigV5IfExists } from './config/config-v5.js';
import { readRelayConfig, relayLogin, removeRelayConfig } from './relay/login.js';
import {
  installLaunchAgent,
  launchAgentStatus,
  uninstallLaunchAgent,
} from './service/launchd.js';

/** CLI 可选依赖；入口路径用于 launchd plist。 */
export interface CliOptions {
  entryPath?: string;
}

/** CLI `start` 的唯一运行时：S04 持久化路径（含 `/ws/asr` 网关）。 */
export function createStartRuntime(configDir: string) {
  const attachments = new AttachmentStore(join(configDir, 'attachments'));
  return createDurableAgentRuntime(
    new AgentSdkAdapter({
      loadAttachments: (runId) => attachments.loadForRun(runId),
    }),
    { configDir, attachments },
  );
}

/** 构造 Agent CLI；运行中管理操作统一走本机 Unix socket。 */
export function createCli(
  configDir: string = DEFAULT_CONFIG_DIR,
  cliOptions: CliOptions = {},
): Command {
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
    .option('--base-url <url>', 'https tunnel base url')
    .option('--lan', 'listen on the local network with a private http url')
    .action(
      async (options: {
        workspace: string;
        name: string;
        baseUrl?: string;
        lan?: boolean;
      }) => {
        const lanMode = options.lan === true;
        if (lanMode === (options.baseUrl !== undefined)) {
          throw new Error('provide exactly one of --base-url or --lan');
        }
        const config = await initializeConfig({
          configDir,
          workspacePath: options.workspace,
          displayName: options.name,
          tailscaleBaseUrl: lanMode
            ? lanBaseUrl(detectLanAddress())
            : requireValue(options.baseUrl),
          ...(lanMode ? { lanMode: true } : {}),
        });
        process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      },
    );

  program
    .command('start')
    .description('start the agent in the foreground')
    .action(async () => {
      const runtime = await createStartRuntime(configDir);
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
      // 供无法扫码的客户端（iOS 模拟器）直接粘贴。
      process.stdout.write(`payload: ${JSON.stringify(payload)}\n`);
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
    .description('list authorized projects through the running agent')
    .action(async () => {
      const workspaces = await adminClient().workspaceList();
      process.stdout.write(`${JSON.stringify(workspaces, null, 2)}\n`);
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

  workspace
    .command('set-approval')
    .description('enable or disable mobile approval for one project')
    .argument('<workspaceId>', 'workspace id to update')
    .requiredOption('--mode <mode>', 'allow_once or deny')
    .action(async (workspaceId: string, options: { mode: string }) => {
      if (options.mode !== 'deny' && options.mode !== 'allow_once') {
        throw new Error('--mode must be deny or allow_once');
      }
      const summary = await adminClient().workspaceSetApproval(
        workspaceId,
        options.mode,
      );
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    });

  program
    .command('doctor')
    .description('check config, storage, agent, endpoint, log and versions')
    .action(async () => {
      const report = await runDoctor({ configDir });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.ok) process.exitCode = 1;
    });

  const lan = program
    .command('lan')
    .description('local network direct mode');

  lan
    .command('status')
    .description('show the current access mode and base url')
    .action(() => {
      process.stdout.write(`${JSON.stringify(lanStatus(configDir), null, 2)}\n`);
    });

  lan
    .command('enable')
    .description('listen on the local network with a private http url')
    .action(async () => {
      const result = await enableLan(configDir);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(
        'restart the agent, then run "pair --replace" and scan again from the same Wi-Fi\n',
      );
    });

  lan
    .command('disable')
    .description('go back to loopback with an https tunnel url')
    .requiredOption('--base-url <url>', 'https tunnel base url')
    .action((options: { baseUrl: string }) => {
      const result = disableLan(configDir, options.baseUrl);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  const diagnostics = program
    .command('diagnostics')
    .description('build a redacted diagnostics bundle');

  diagnostics
    .command('export')
    .description('write a redacted diagnostics bundle to a file')
    .requiredOption('--output <path>', 'output file path')
    .action(async (options: { output: string }) => {
      const bundle = await buildDiagnostics({ configDir });
      await writeDiagnostics(bundle, options.output);
      process.stdout.write(`diagnostics written to ${options.output}\n`);
    });

  const relay = program
    .command('relay')
    .description('cloud relay mode');

  relay
    .command('login')
    .description('log in to the cloud relay and store credentials')
    .requiredOption('--url <baseUrl>', 'relay base url')
    .requiredOption('--username <username>', 'account username')
    .requiredOption('--password <password>', 'account password')
    .option('--name <desktopName>', 'desktop name shown on phones')
    .action(
      async (options: {
        url: string;
        username: string;
        password: string;
        name?: string;
      }) => {
        const result = await relayLogin({
          configDir,
          baseUrl: options.url,
          username: options.username,
          password: options.password,
          ...(options.name === undefined ? {} : { desktopName: options.name }),
        });
        process.stdout.write(
          `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`,
        );
      },
    );

  relay
    .command('status')
    .description('show relay configuration (never prints the token)')
    .action(() => {
      const relayConfig = readRelayConfig(configDir);
      const configV5 = readConfigV5IfExists(configDir);
      const status =
        relayConfig === null
          ? { enabled: false }
          : {
              enabled: true,
              baseUrl: relayConfig.baseUrl,
              desktopId: configV5?.desktopId ?? null,
              desktopName: relayConfig.desktopName,
            };
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    });

  relay
    .command('logout')
    .description('remove relay credentials from the local config')
    .action(() => {
      removeRelayConfig(configDir);
      process.stdout.write('relay credentials removed\n');
    });

  const service = program
    .command('service')
    .description('manage the launchd agent service');

  service
    .command('install')
    .description('install and load the launch agent')
    .option('--node <path>', 'node executable', process.execPath)
    .option('--entry <path>', 'agent entry file')
    .option('--cwd <path>', 'working directory', process.cwd())
    .option(
      '--env <assignment>',
      'KEY=VALUE environment variable; repeatable',
      collectEnvironment,
      {},
    )
    .action(
      async (options: {
        node: string;
        entry?: string;
        cwd: string;
        env: Record<string, string>;
      }) => {
        const entryPath = options.entry ?? cliOptions.entryPath;
        if (entryPath === undefined) {
          throw new Error('agent entry path is unknown; pass --entry');
        }
        const result = await installLaunchAgent({
          entryPath,
          workingDirectory: options.cwd,
          configDir,
          nodePath: options.node,
          environment: options.env,
        });
        process.stdout.write(`installed ${result.plistPath}\n`);
        process.stdout.write(
          'environment values were written to the plist (mode 0600) and are not printed\n',
        );
      },
    );

  service
    .command('uninstall')
    .description('stop and remove the launch agent')
    .action(async () => {
      const result = await uninstallLaunchAgent();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  service
    .command('status')
    .description('show whether the launch agent is installed and loaded')
    .action(async () => {
      const result = await launchAgentStatus();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  return program;
}

/** 收集重复传入的 `--env KEY=VALUE`；不打印值。 */
function collectEnvironment(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const separator = value.indexOf('=');
  if (separator <= 0) {
    throw new Error('--env must be KEY=VALUE');
  }
  return {
    ...previous,
    [value.slice(0, separator)]: value.slice(separator + 1),
  };
}

/** 局域网 baseUrl；没有可用网卡时直接失败。 */
function lanBaseUrl(address: string | null): string {
  if (address === null) {
    throw new Error('no private IPv4 address found; connect to Wi-Fi first');
  }
  return `http://${address}:${AGENT_LISTEN_PORT}`;
}

function requireValue(value: string | undefined): string {
  if (value === undefined) throw new Error('missing required value');
  return value;
}

/** 解析并执行 CLI，返回进程退出码。 */
export async function main(
  argv: readonly string[],
  options: { configDir?: string; entryPath?: string } = {},
): Promise<number> {
  const program = createCli(options.configDir ?? DEFAULT_CONFIG_DIR, {
    ...(options.entryPath === undefined
      ? {}
      : { entryPath: options.entryPath }),
  });
  await program.parseAsync(['node', 'claude-remote-agent', ...argv]);
  return 0;
}