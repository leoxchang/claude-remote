import { appendFileSync } from 'node:fs';

/** 只记录结构化元数据的日志器；不记录 prompt 正文、令牌或请求头。 */
export interface AgentLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

/** 追加 JSON 行日志；写失败只报告到 stderr，不影响主流程。 */
export function createFileLogger(path: string): AgentLogger {
  const write = (
    level: 'info' | 'warn',
    event: string,
    fields: Record<string, unknown> = {},
  ): void => {
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