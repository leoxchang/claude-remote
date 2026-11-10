import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** 可注入的命令执行器，便于测试不触碰真实 Tailscale。 */
export type ExecFile = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Serve 检查结果。 */
export interface TailscaleServeStatus {
  https: boolean;
  funnel: boolean;
  host: string;
}

const SERVE_STATUS_COMMAND = 'tailscale';
const SERVE_STATUS_ARGS = ['serve', 'status', '--json'] as const;
const HTTPS_PORT_SUFFIX = ':443';

const execFileAsync = promisify(execFile);

const defaultExec: ExecFile = async (file, args) => {
  const result = await execFileAsync(file, [...args]);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

/**
 * 只读 Serve 状态：要求存在 HTTPS 入口，且 Funnel 未启用。
 * 不自动开启或修改任何 Tailscale 配置。
 */
export async function checkTailscaleServe(
  exec: ExecFile = defaultExec,
): Promise<TailscaleServeStatus> {
  const { stdout } = await exec(SERVE_STATUS_COMMAND, SERVE_STATUS_ARGS);
  const parsed = parseStatus(stdout);
  const web = isRecord(parsed['Web']) ? parsed['Web'] : {};
  const httpsEntries = Object.keys(web).filter((entry) =>
    entry.endsWith(HTTPS_PORT_SUFFIX),
  );
  const allowFunnel = isRecord(parsed['AllowFunnel'])
    ? parsed['AllowFunnel']
    : {};
  if (Object.values(allowFunnel).some((value) => value === true)) {
    throw new Error('tailscale funnel must not be enabled');
  }
  const firstEntry = httpsEntries[0] ?? '';
  return {
    https: httpsEntries.length > 0,
    funnel: false,
    host: firstEntry.slice(0, firstEntry.length - HTTPS_PORT_SUFFIX.length),
  };
}

function parseStatus(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('tailscale serve status is not JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('tailscale serve status is not a JSON object');
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}