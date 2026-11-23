import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import BetterSqlite3 from 'better-sqlite3';

import { AdminClient } from '../admin/client.js';
import {
  DEFAULT_DATABASE_FILE,
  readConfigV4IfExists,
  resolveDatabasePath,
} from '../config/config-v4.js';
import { LAN_LISTEN_HOST, resolveAgentPaths } from '../config/paths.js';
import { detectLanAddress } from '../config/lan.js';
import { AgentVersions, agentVersions } from '../app/versions.js';

const TAILSCALE_TIMEOUT_MS = 5_000;

/** 单项检查结果。 */
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

/** 一条诊断检查。 */
export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  detail: string;
}

/** `agent doctor` 的完整报告。 */
export interface DoctorReport {
  generatedAt: string;
  versions: AgentVersions;
  checks: DoctorCheck[];
  ok: boolean;
}

/** 外部命令执行器；测试可注入。 */
export type DoctorCommandRunner = (
  command: string,
  args: string[],
) => Promise<string>;

/** doctor 选项。 */
export interface DoctorOptions {
  configDir: string;
  platform?: NodeJS.Platform;
  runCommand?: DoctorCommandRunner;
}

const execFileAsync = promisify(execFile);

/** 运行全部检查；任一 fail 则 ok=false。 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const checks = [
    checkConfig(options.configDir),
    checkStorage(options.configDir),
    await checkAgent(options.configDir),
    await checkEndpoint(options.configDir, platform, runCommand),
    checkLog(options.configDir),
    checkVersions(),
  ];
  return {
    generatedAt: new Date().toISOString(),
    versions: agentVersions(),
    checks,
    ok: checks.every((check) => check.status !== 'fail'),
  };
}

function checkConfig(configDir: string): DoctorCheck {
  const paths = resolveAgentPaths(configDir);
  if (!existsSync(paths.agentFile)) {
    return {
      id: 'config',
      status: 'fail',
      detail: `agent.json not found at ${paths.agentFile}; run init first`,
    };
  }
  const v4 = readConfigV4IfExists(configDir);
  return {
    id: 'config',
    status: 'pass',
    detail:
      v4 === null
        ? 'agent.json present; V4 migration will run on next start'
        : `agent.json V4 present; desktopId=${v4.desktopId}`,
  };
}

function checkStorage(configDir: string): DoctorCheck {
  const paths = resolveAgentPaths(configDir);
  const v4 = readConfigV4IfExists(configDir);
  const databasePath =
    v4 === null
      ? join(configDir, DEFAULT_DATABASE_FILE)
      : resolveDatabasePath(configDir, v4);
  if (!existsSync(databasePath)) {
    return {
      id: 'storage',
      status: 'warn',
      detail: `database not created yet at ${databasePath}`,
    };
  }
  try {
    const database = new BetterSqlite3(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const row = database.prepare('PRAGMA integrity_check').get() as
        | { integrity_check?: unknown }
        | undefined;
      const result = row?.integrity_check;
      if (result !== 'ok') {
        return {
          id: 'storage',
          status: 'fail',
          detail: `integrity_check returned ${String(result)}`,
        };
      }
    } finally {
      database.close();
    }
    return { id: 'storage', status: 'pass', detail: databasePath };
  } catch (error: unknown) {
    return {
      id: 'storage',
      status: 'fail',
      detail: `cannot open database: ${String(error)}`,
    };
  }
}

async function checkAgent(configDir: string): Promise<DoctorCheck> {
  const client = new AdminClient(resolveAgentPaths(configDir).socketPath);
  try {
    const status = await client.status();
    return {
      id: 'agent',
      status: 'pass',
      detail: `running; desktopId=${status.desktopId}`,
    };
  } catch {
    return {
      id: 'agent',
      status: 'warn',
      detail: 'agent is not running (start it or install the launchd service)',
    };
  }
}

async function checkEndpoint(
  configDir: string,
  platform: NodeJS.Platform,
  runCommand: DoctorCommandRunner,
): Promise<DoctorCheck> {
  const config = readConfigV4IfExists(configDir);
  if (config === null) {
    return {
      id: 'endpoint',
      status: 'warn',
      detail: 'config is not V4 yet; start the agent once',
    };
  }
  const baseUrl = config.tailscale.baseUrl;
  const hostname = new URL(baseUrl).hostname;
  if (config.listen.host === LAN_LISTEN_HOST) {
    return lanEndpointCheck(baseUrl, hostname);
  }
  if (!hostname.endsWith('.ts.net')) {
    return {
      id: 'endpoint',
      status: 'pass',
      detail: `tunnel endpoint ${baseUrl}`,
    };
  }
  return tailscaleEndpointCheck(platform, runCommand);
}

function lanEndpointCheck(baseUrl: string, hostname: string): DoctorCheck {
  const lanAddress = detectLanAddress();
  if (lanAddress === null) {
    return {
      id: 'endpoint',
      status: 'warn',
      detail: 'LAN mode is on but no private IPv4 address was found',
    };
  }
  if (hostname !== lanAddress) {
    return {
      id: 'endpoint',
      status: 'warn',
      detail: `LAN address changed to ${lanAddress}; run "lan enable" again`,
    };
  }
  return {
    id: 'endpoint',
    status: 'pass',
    detail: `LAN mode ${baseUrl}; allow incoming connections in the macOS firewall`,
  };
}

async function tailscaleEndpointCheck(
  platform: NodeJS.Platform,
  runCommand: DoctorCommandRunner,
): Promise<DoctorCheck> {
  if (platform !== 'darwin') {
    return {
      id: 'endpoint',
      status: 'warn',
      detail: 'Tailscale check only applies on macOS',
    };
  }
  try {
    const serve = await runCommand('tailscale', ['serve', 'status']);
    if (serve.trim().length === 0 || serve.includes('No serve config')) {
      return {
        id: 'endpoint',
        status: 'warn',
        detail: 'no serve config; run "tailscale serve --bg 8787"',
      };
    }
    const funnel = await runCommand('tailscale', ['funnel', 'status']);
    if (funnelEnabled(funnel)) {
      return {
        id: 'endpoint',
        status: 'fail',
        detail: 'Funnel is enabled; disable it and use Serve only',
      };
    }
    return {
      id: 'endpoint',
      status: 'pass',
      detail: 'Serve configured; Funnel off',
    };
  } catch (error: unknown) {
    return {
      id: 'endpoint',
      status: 'warn',
      detail: `tailscale check failed: ${String(error)}`,
    };
  }
}

function funnelEnabled(output: string): boolean {
  if (output.toLowerCase().includes('not enabled')) return false;
  return output.includes('https://');
}

function checkLog(configDir: string): DoctorCheck {
  const logFile = resolveAgentPaths(configDir).logFile;
  try {
    const size = statSync(logFile).size;
    return {
      id: 'log',
      status: 'pass',
      detail: `${logFile} (${size} bytes)`,
    };
  } catch {
    return {
      id: 'log',
      status: 'warn',
      detail: `no log file yet at ${logFile}`,
    };
  }
}

function checkVersions(): DoctorCheck {
  const versions = agentVersions();
  return {
    id: 'versions',
    status: 'pass',
    detail: `agent=${versions.agent} sdk=${versions.sdk} runtime=${versions.runtime} protocol=${versions.protocol}`,
  };
}

async function defaultRunCommand(
  command: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: TAILSCALE_TIMEOUT_MS,
    encoding: 'utf8',
  });
  return stdout;
}