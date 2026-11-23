import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

/** launchd 服务标签；用户级 LaunchAgent 唯一标识。 */
export const SERVICE_LABEL = 'com.claude-remote.agent';

/** plist 权限：仅当前用户可见，因为可能含环境变量。 */
const PLIST_MODE = 0o600;

/** launchctl 调用超时。 */
const COMMAND_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

/** 外部命令执行器；测试可注入。 */
export type ServiceCommandRunner = (
  command: string,
  args: string[],
) => Promise<string>;

/** 生成 LaunchAgent plist 的输入。 */
export interface LaunchAgentOptions {
  /** `src/main.ts` 或编译后的入口绝对路径。 */
  entryPath: string;
  /** launchd 进程的工作目录；应指向仓库根目录，便于解析 tsx。 */
  workingDirectory: string;
  /** Agent 配置目录；通过 CLAUDE_REMOTE_CONFIG_DIR 注入。 */
  configDir: string;
  /** Node 可执行文件；默认当前进程。 */
  nodePath?: string;
  /** 额外环境变量；DOUBAO_ASR_API_KEY 只能经此注入。 */
  environment?: Record<string, string>;
  /** 安装目标 home；测试可覆盖。 */
  homeDir?: string;
  /** 日志目录；默认与 configDir 相同。 */
  logDir?: string;
  /** launchctl 执行器；测试可注入。 */
  runCommand?: ServiceCommandRunner;
}

/** 安装结果；不包含任何环境变量值。 */
export interface ServiceInstallResult {
  plistPath: string;
  label: string;
}

/** 卸载结果。 */
export interface ServiceUninstallResult {
  plistPath: string;
  removed: boolean;
}

/** 服务状态。 */
export interface ServiceStatusResult {
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  detail: string;
}

/** 默认 plist 路径：`~/Library/LaunchAgents/<label>.plist`。 */
export function launchAgentPlistPath(homeDir: string = homedir()): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

/** 生成 LaunchAgent plist；纯函数，便于测试。 */
export function buildLaunchAgentPlist(options: LaunchAgentOptions): string {
  const nodePath = options.nodePath ?? process.execPath;
  const logDir = options.logDir ?? options.configDir;
  const programArguments = options.entryPath.endsWith('.ts')
    ? [nodePath, '--import', 'tsx', options.entryPath, 'start']
    : [nodePath, options.entryPath, 'start'];
  const environment: Record<string, string> = {
    CLAUDE_REMOTE_CONFIG_DIR: options.configDir,
    ...options.environment,
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    keyValue('Label', SERVICE_LABEL),
    `  <key>ProgramArguments</key>`,
    '  <array>',
    ...programArguments.map((argument) => `    ${plistString(argument)}`),
    '  </array>',
    keyValue('WorkingDirectory', options.workingDirectory),
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    keyValue('StandardOutPath', join(logDir, 'launchd.out.log')),
    keyValue('StandardErrorPath', join(logDir, 'launchd.err.log')),
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...environmentEntries(environment),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** 写入 plist 并加载服务；已加载时先卸载再加载。 */
export async function installLaunchAgent(
  options: LaunchAgentOptions,
): Promise<ServiceInstallResult> {
  const homeDir = options.homeDir ?? homedir();
  const plistPath = launchAgentPlistPath(homeDir);
  const run = options.runCommand ?? defaultRunCommand;
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, buildLaunchAgentPlist(options), {
    mode: PLIST_MODE,
  });
  await chmod(plistPath, PLIST_MODE);
  const uid = currentUid();
  await run('launchctl', [
    'bootout',
    `gui/${uid}/${SERVICE_LABEL}`,
  ]).catch(() => undefined);
  try {
    await run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  } catch (error: unknown) {
    throw new Error(`launchctl bootstrap failed: ${String(error)}`);
  }
  return { plistPath, label: SERVICE_LABEL };
}

/** 停止并移除服务；未加载或 plist 不存在时也视为成功。 */
export async function uninstallLaunchAgent(
  options: {
    homeDir?: string;
    runCommand?: ServiceCommandRunner;
  } = {},
): Promise<ServiceUninstallResult> {
  const plistPath = launchAgentPlistPath(options.homeDir ?? homedir());
  const run = options.runCommand ?? defaultRunCommand;
  const uid = currentUid();
  await run('launchctl', [
    'bootout',
    `gui/${uid}/${SERVICE_LABEL}`,
  ]).catch(() => undefined);
  const removed = existsSync(plistPath);
  await rm(plistPath, { force: true });
  return { plistPath, removed };
}

/** 查询服务是否安装与加载；不修改系统状态。 */
export async function launchAgentStatus(
  options: {
    homeDir?: string;
    runCommand?: ServiceCommandRunner;
  } = {},
): Promise<ServiceStatusResult> {
  const plistPath = launchAgentPlistPath(options.homeDir ?? homedir());
  const installed = existsSync(plistPath);
  const run = options.runCommand ?? defaultRunCommand;
  const uid = currentUid();
  try {
    const output = await run('launchctl', [
      'print',
      `gui/${uid}/${SERVICE_LABEL}`,
    ]);
    const firstLine = output.split('\n')[0] ?? '';
    return { plistPath, installed, loaded: true, detail: firstLine };
  } catch {
    return { plistPath, installed, loaded: false, detail: 'not loaded' };
  }
}

function currentUid(): number {
  return process.getuid === undefined ? 501 : process.getuid();
}

function keyValue(key: string, value: string): string {
  return `  <key>${key}</key>\n  ${plistString(value)}`;
}

function environmentEntries(
  environment: Record<string, string>,
): string[] {
  return Object.keys(environment)
    .sort()
    .flatMap((key) => [
      `    <key>${escapeXml(key)}</key>`,
      `    ${plistString(environment[key] ?? '')}`,
    ]);
}

function plistString(value: string): string {
  return `<string>${escapeXml(value)}</string>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function defaultRunCommand(
  command: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: COMMAND_TIMEOUT_MS,
    encoding: 'utf8',
  });
  return stdout;
}