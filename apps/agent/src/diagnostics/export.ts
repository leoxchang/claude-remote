import { chmod, readFile, stat, writeFile } from 'node:fs/promises';

import { AdminClient } from '../admin/client.js';
import { AdminStatus } from '../admin/server.js';
import { AgentVersions, agentVersions } from '../app/versions.js';
import { resolveAgentPaths } from '../config/paths.js';
import { DoctorReport, DoctorCommandRunner, runDoctor } from './doctor.js';

/** 默认导出的日志尾部行数。 */
export const DIAGNOSTIC_LOG_LINES = 200;

/** 诊断包中的文件大小信息。 */
export interface DiagnosticFile {
  path: string;
  bytes: number | null;
}

/** 脱敏诊断包；只含元数据，不含 prompt、回复、音频或密钥。 */
export interface DiagnosticBundle {
  generatedAt: string;
  versions: AgentVersions;
  doctor: DoctorReport;
  status: AdminStatus | null;
  logs: string[];
  files: DiagnosticFile[];
  note: string;
}

/** 诊断包构建选项。 */
export interface DiagnosticsOptions {
  configDir: string;
  logLines?: number;
  /** doctor 的平台与命令执行器；测试可注入。 */
  platform?: NodeJS.Platform;
  runCommand?: DoctorCommandRunner;
}

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/Bearer\s+[^\s"']+/g, 'Bearer [REDACTED]'],
  [/"deviceToken"\s*:\s*"[^"]*"/g, '"deviceToken":"[REDACTED]"'],
  [/"code"\s*:\s*"[^"]*"/g, '"code":"[REDACTED]"'],
  [/"apiKey"\s*:\s*"[^"]*"/gi, '"apiKey":"[REDACTED]"'],
];

/** 汇总 doctor、运行状态与日志尾部。 */
export async function buildDiagnostics(
  options: DiagnosticsOptions,
): Promise<DiagnosticBundle> {
  const paths = resolveAgentPaths(options.configDir);
  const doctor = await runDoctor({
    configDir: options.configDir,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.runCommand === undefined
      ? {}
      : { runCommand: options.runCommand }),
  });
  return {
    generatedAt: new Date().toISOString(),
    versions: agentVersions(),
    doctor,
    status: await readStatus(paths.socketPath),
    logs: await readLogTail(paths.logFile, options.logLines ?? DIAGNOSTIC_LOG_LINES),
    files: [{ path: paths.logFile, bytes: await fileSize(paths.logFile) }],
    note:
      'Metadata only: prompts, replies, audio, tokens and keys are excluded or redacted.',
  };
}

/** 以 0600 写入诊断包；覆盖已有文件时也会收紧权限。 */
export async function writeDiagnostics(
  bundle: DiagnosticBundle,
  outputPath: string,
): Promise<void> {
  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(outputPath, 0o600);
}

/** 遮蔽令牌、配对码与密钥字段；保留其余元数据。 */
export function redact(text: string): string {
  return REDACTIONS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
}

async function readStatus(socketPath: string): Promise<AdminStatus | null> {
  try {
    return await new AdminClient(socketPath).status();
  } catch {
    return null;
  }
}

async function readLogTail(
  logFile: string,
  lines: number,
): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(logFile, 'utf8');
  } catch {
    return [];
  }
  const entries = text
    .split('\n')
    .filter((line) => line.length > 0)
    .slice(-lines);
  return entries.map(redact);
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}