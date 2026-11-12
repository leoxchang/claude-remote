import { realpathSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { AgentError } from '../command/errors.js';
import { WorkspaceRecord } from '../workspace/workspace-types.js';

/** 解析并校验项目真实路径；相对路径、缺失和非目录一律拒绝。 */
export async function resolveWorkspacePath(input: string): Promise<string> {
  if (!isAbsolute(input)) {
    throw new AgentError('INVALID_MESSAGE');
  }
  const stats = await stat(input).catch(() => undefined);
  if (stats === undefined || !stats.isDirectory()) {
    throw new AgentError('WORKSPACE_NOT_ALLOWED');
  }
  const resolved = await realpath(input).catch(() => undefined);
  if (resolved === undefined) {
    throw new AgentError('WORKSPACE_NOT_ALLOWED');
  }
  return resolved;
}

/**
 * 在启动 run 前同步复核保存的真实路径。
 *
 * 目录被删除、不再是目录或被符号链接改指时抛 WORKSPACE_NOT_ALLOWED，
 * 调用方不得创建 SDK query。
 */
export function assertWorkspacePathCurrent(record: WorkspaceRecord): void {
  let current: string;
  try {
    if (!statSync(record.rootPath).isDirectory()) {
      throw new AgentError('WORKSPACE_NOT_ALLOWED');
    }
    current = realpathSync.native(record.rootPath);
  } catch {
    throw new AgentError('WORKSPACE_NOT_ALLOWED');
  }
  if (current !== record.rootPath) {
    throw new AgentError('WORKSPACE_NOT_ALLOWED');
  }
}