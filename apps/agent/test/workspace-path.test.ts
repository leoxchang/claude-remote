import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertWorkspacePathCurrent,
  resolveWorkspacePath,
} from '../src/config/workspace-path.js';
import { WorkspaceRecord } from '../src/workspace/workspace-types.js';

let root: string;

function record(rootPath: string): WorkspaceRecord {
  return {
    workspaceId: 'ws_alpha',
    displayName: 'Fixture Alpha',
    rootPath,
    createdAt: 1_762_432_800_000,
    policy: { perSessionQueueLimit: 20 },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-remote-path-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveWorkspacePath', () => {
  it('rejects a relative path', async () => {
    await expect(resolveWorkspacePath('relative/dir')).rejects.toThrow(
      'INVALID_MESSAGE',
    );
  });

  it('rejects a missing path', async () => {
    await expect(
      resolveWorkspacePath(join(root, 'missing')),
    ).rejects.toThrow('WORKSPACE_NOT_ALLOWED');
  });

  it('rejects a file that is not a directory', async () => {
    const file = join(root, 'file.txt');
    await writeFile(file, 'x');

    await expect(resolveWorkspacePath(file)).rejects.toThrow(
      'WORKSPACE_NOT_ALLOWED',
    );
  });

  it('resolves a symlink to the real directory', async () => {
    const real = join(root, 'real');
    const link = join(root, 'link');
    await mkdir(real);
    await symlink(real, link);

    expect(await resolveWorkspacePath(link)).toBe(await resolveWorkspacePath(real));
  });
});

describe('assertWorkspacePathCurrent', () => {
  it('passes while the recorded real path is unchanged', async () => {
    const real = join(root, 'real');
    await mkdir(real);
    const rootPath = await resolveWorkspacePath(real);

    expect(() => assertWorkspacePathCurrent(record(rootPath))).not.toThrow();
  });

  it('rejects a removed root directory', async () => {
    const real = join(root, 'real');
    await mkdir(real);
    const rootPath = await resolveWorkspacePath(real);
    await rm(real, { recursive: true });

    expect(() => assertWorkspacePathCurrent(record(rootPath))).toThrow(
      'WORKSPACE_NOT_ALLOWED',
    );
  });

  it('rejects a root path that was replaced by a symlink', async () => {
    const real = join(root, 'real');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(real);
    await mkdir(elsewhere);
    const rootPath = await resolveWorkspacePath(real);
    await rm(real, { recursive: true });
    await symlink(elsewhere, real);

    expect(() => assertWorkspacePathCurrent(record(rootPath))).toThrow(
      'WORKSPACE_NOT_ALLOWED',
    );
  });

  it('rejects a record that stored a symlink instead of the real path', async () => {
    const real = join(root, 'real');
    const link = join(root, 'link');
    await mkdir(real);
    await symlink(real, link);

    expect(() => assertWorkspacePathCurrent(record(link))).toThrow(
      'WORKSPACE_NOT_ALLOWED',
    );
  });
});