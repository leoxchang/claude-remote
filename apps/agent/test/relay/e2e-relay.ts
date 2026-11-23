import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const STARTUP_TIMEOUT_MS = 15000;
const STDERR_TAIL = 2000;

/** 真实 relay 进程句柄；e2e 助手只经 CLI 与网络触达实现。 */
export interface RealRelay {
  baseUrl: string;
  dataDir: string;
  runAdmin(args: string[]): Promise<string>;
  stop(): Promise<void>;
}

/** spawn 真实 apps/relay（RELAY_PORT=0 + 临时数据目录），解析启动事件行。 */
export async function startRealRelay(): Promise<RealRelay> {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-e2e-relay-'));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/relay/src/main.ts'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, RELAY_PORT: '0', RELAY_DATA_DIR: dataDir },
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
    runAdmin: (args) => runAdmin(dataDir, args),
    stop: async () => {
      await stopChild(child);
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/** 经 relay admin CLI 执行管理操作。 */
export function runAdmin(dataDir: string, args: string[]): Promise<string> {
  const bin = join(REPO_ROOT, 'apps/relay/bin/claude-remote-relay.js');
  return new Promise((resolveRun, reject) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, RELAY_DATA_DIR: dataDir } },
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

/** 契约 §3.1 登录；失败抛 HTTP 状态。 */
export async function login(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
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