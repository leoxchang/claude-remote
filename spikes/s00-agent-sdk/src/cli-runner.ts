import { spawn } from 'node:child_process';

const CLI_TIMEOUT_MS = 180_000;

/** 一次 CLI 调用的结果；不接受 shell 字符串。 */
export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * 以 fixture cwd 执行 `claude`，参数逐个传入、无 shell、显式超时。
 *
 * 使用 spawn 而不是 execFile：execFile 会提供一个永不关闭的 stdin 管道，
 * CLI 会等待 3 秒后才继续，并在部分运行里以非零码退出。这里把 stdin 设为
 * ignore（等价于 < /dev/null），行为更接近计划要求的确定性调用。
 */
export function runCli(
  args: readonly string[],
  cwd: string,
): Promise<CliRunResult> {
  return new Promise((resolve) => {
    const child = spawn('claude', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, CLI_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: 1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: timedOut ? 1 : (code ?? 1) });
    });
  });
}