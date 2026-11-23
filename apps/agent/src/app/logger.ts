import { appendFileSync, renameSync, statSync, unlinkSync } from 'node:fs';

/** 默认单个日志文件上限：10 MiB。 */
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** 默认保留的轮转文件数；不含当前文件。 */
export const DEFAULT_LOG_KEEP_FILES = 3;

/** 只记录结构化元数据的日志器；不记录 prompt 正文、令牌或请求头。 */
export interface AgentLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

/** 文件日志的轮转参数。 */
export interface FileLoggerOptions {
  /** 当前文件达到该字节数时轮转；默认 10 MiB。 */
  maxBytes?: number;
  /** 保留的轮转文件数量；默认 3。 */
  keepFiles?: number;
}

/** 追加 JSON 行日志；写失败只报告到 stderr，不影响主流程。 */
export function createFileLogger(
  path: string,
  options: FileLoggerOptions = {},
): AgentLogger {
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const keepFiles = options.keepFiles ?? DEFAULT_LOG_KEEP_FILES;

  const write = (
    level: 'info' | 'warn',
    event: string,
    fields: Record<string, unknown> = {},
  ): void => {
    rotateIfNeeded(path, maxBytes, keepFiles);
    try {
      appendFileSync(
        path,
        `${JSON.stringify({ level, event, at: new Date().toISOString(), ...fields })}\n`,
        { mode: 0o600 },
      );
    } catch (error: unknown) {
      process.stderr.write(`log write failed: ${String(error)}\n`);
    }
  };

  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
  };
}

/**
 * 超过上限时依次重命名 `.1`…`.keepFiles`；任何一步失败都不阻断本次写入。
 * 轮转失败时当前文件继续追加，下一次写入会再次尝试。
 */
function rotateIfNeeded(
  path: string,
  maxBytes: number,
  keepFiles: number,
): void {
  const size = currentFileSize(path);
  if (size === undefined || size < maxBytes) return;

  removeIfExists(`${path}.${keepFiles}`);
  for (let index = keepFiles - 1; index >= 1; index -= 1) {
    renameIfExists(`${path}.${index}`, `${path}.${index + 1}`);
  }
  renameIfExists(path, `${path}.1`);
}

function currentFileSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function removeIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 文件不存在或已删除；轮转继续。
  }
}

function renameIfExists(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    // 源文件不存在；轮转继续。
  }
}