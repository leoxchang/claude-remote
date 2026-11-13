import { chmodSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { lockSync, unlockSync } from 'proper-lockfile';

import { AgentError } from '../command/errors.js';

/** 锁文件权限。 */
export const LOCK_FILE_MODE = 0o600;

/** 默认判定 stale 的锁年龄。 */
export const DEFAULT_STALE_MS = 30_000;

/** 锁元数据；只含标识，不含凭证。 */
export interface LockInfo {
  desktopId: string;
  databasePath: string;
  pid: number;
  acquiredAt: number;
}

export interface InstanceLockInput {
  lockPath: string;
  desktopId: string;
  databasePath: string;
  pid?: number;
  staleMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

/** 单实例锁；release 可重复调用。 */
export class InstanceLockHandle {
  private released = false;

  constructor(
    private readonly lockPath: string,
    private readonly releaseLock: () => void,
    private readonly value: LockInfo,
  ) {}

  info(): LockInfo {
    return { ...this.value };
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    rmSync(`${this.lockPath}.json`, { force: true });
    this.releaseLock();
  }
}

/**
 * 单 writer 启动锁。
 *
 * 与 desktopId/database realpath 绑定；活 PID 永不被抢占，
 * 只有确认旧进程不存在（或无元数据且锁已过期）才回收。
 */
export class InstanceLock {
  static acquire(input: InstanceLockInput): InstanceLockHandle {
    const pid = input.pid ?? process.pid;
    const staleMs = input.staleMs ?? DEFAULT_STALE_MS;
    const isAlive = input.isProcessAlive ?? defaultIsProcessAlive;
    const databasePath = canonicalDatabasePath(input.databasePath);
    const metadataPath = `${input.lockPath}.json`;

    let releaseLock = acquireLock(input.lockPath, staleMs);
    if (releaseLock === null) {
      const info = readInfo(metadataPath);
      if (info !== null) {
        if (isAlive(info.pid)) throw new AgentError('AGENT_ALREADY_RUNNING');
      } else if (lockAgeMs(input.lockPath) < staleMs) {
        throw new AgentError('AGENT_ALREADY_RUNNING');
      }
      forceUnlock(input.lockPath);
      releaseLock = acquireLock(input.lockPath, staleMs);
      if (releaseLock === null) throw new AgentError('AGENT_ALREADY_RUNNING');
    }

    const info: LockInfo = {
      desktopId: input.desktopId,
      databasePath,
      pid,
      acquiredAt: Date.now(),
    };
    try {
      writeFileSync(metadataPath, `${JSON.stringify(info)}\n`, {
        mode: LOCK_FILE_MODE,
      });
      chmodSync(metadataPath, LOCK_FILE_MODE);
    } catch (error: unknown) {
      releaseLock();
      throw error;
    }
    return new InstanceLockHandle(input.lockPath, releaseLock, info);
  }
}

function acquireLock(lockPath: string, staleMs: number): (() => void) | null {
  try {
    return lockSync(lockPath, { realpath: false, retries: 0, stale: staleMs });
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ELOCKED') return null;
    throw error;
  }
}

function forceUnlock(lockPath: string): void {
  try {
    unlockSync(lockPath, { realpath: false });
  } catch {
    // 锁目录可能已被回收；继续尝试重新获取。
  }
}

function readInfo(metadataPath: string): LockInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as LockInfo).pid === 'number' &&
      typeof (parsed as LockInfo).desktopId === 'string' &&
      typeof (parsed as LockInfo).databasePath === 'string'
    ) {
      return parsed as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - statSync(`${lockPath}.lock`).mtimeMs;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function canonicalDatabasePath(path: string): string {
  const directory = dirname(path);
  try {
    return join(realpathSync(directory), basename(path));
  } catch {
    return resolve(path);
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}