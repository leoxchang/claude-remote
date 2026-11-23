import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本仓库根目录；契约套件只经网络与 admin CLI 触达实现。 */
export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

const STARTUP_TIMEOUT_MS = 15000;
const STDERR_TAIL = 2000;

/** 运行中的 relay 句柄。跨语言验收模式下 stop 为空操作。 */
export interface RelayHandle {
  baseUrl: string;
  dataDir: string;
  stop(): Promise<void>;
}

/**
 * 启动被测 relay。
 * 设置 RELAY_BASE_URL 时直接复用外部实现（跨语言验收模式），
 * 此时 dataDir 取 RELAY_DATA_DIR，admin 操作须由实现提供等价入口。
 */
export async function startRelay(options?: {
  dataDir?: string;
}): Promise<RelayHandle> {
  const externalUrl = process.env['RELAY_BASE_URL'];
  if (externalUrl !== undefined && options?.dataDir === undefined) {
    return {
      baseUrl: externalUrl.replace(/\/$/, ''),
      dataDir: process.env['RELAY_DATA_DIR'] ?? '',
      stop: async () => Promise.resolve(),
    };
  }
  const ownsDataDir = options?.dataDir === undefined;
  const dataDir =
    options?.dataDir ?? mkdtempSync(join(tmpdir(), 'relay-contract-'));
  const env: Record<string, string | undefined> = {
    ...process.env,
    RELAY_PORT: '0',
    RELAY_DATA_DIR: dataDir,
  };
  delete env['RELAY_BASE_URL'];
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/relay/src/main.ts'],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
  });
  const port = await readStartedPort(child, () => stderrTail);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    stop: async () => {
      await stopChild(child);
      if (ownsDataDir) {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  };
}

/** 经 admin CLI 执行管理操作；失败抛错并带 stderr。 */
export function runAdmin(handle: RelayHandle, args: string[]): Promise<string> {
  const bin = join(REPO_ROOT, 'apps/relay/bin/claude-remote-relay.js');
  return new Promise((resolveRun, reject) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, RELAY_DATA_DIR: handle.dataDir } },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`admin failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolveRun(stdout.trim());
      },
    );
  });
}

/** 轮询等待条件成立；超时抛错。 */
export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
}

function readStartedPort(
  child: ReturnType<typeof spawn>,
  stderr: () => string,
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error('relay startup timeout'));
    }, STARTUP_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line) as { event?: string; port?: number };
          if (
            event.event === 'relay.started' &&
            typeof event.port === 'number'
          ) {
            clearTimeout(timer);
            resolvePort(event.port);
            return;
          }
        } catch {
          // pino 日志行：忽略
        }
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(`relay exited before start (code ${code}): ${stderr()}`),
      );
    });
  });
}

function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    child.once('exit', () => resolveStop());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5000).unref();
  });
}