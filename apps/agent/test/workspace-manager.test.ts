import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentConfigV2 } from '../src/domain/types.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';

let configDir: string;
let fixtureA: string;
let fixtureB: string;

function emptyConfig(): AgentConfigV2 {
  return {
    version: 2,
    desktopId: 'desktop_test',
    workspaces: [],
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: 'https://macbook-pro.tail0970fd.ts.net' },
  };
}

interface Harness {
  manager: WorkspaceManager;
  written: AgentConfigV2[];
  setBusy: (busy: boolean) => void;
  failWrites: (fail: boolean) => void;
}

function setup(config: AgentConfigV2 = emptyConfig()): Harness {
  let busy = false;
  let failing = false;
  const written: AgentConfigV2[] = [];
  const manager = new WorkspaceManager({
    configDir,
    config,
    usage: { hasActiveOrQueued: () => busy },
    writeConfig: (_dir, next) => {
      if (failing) throw new Error('disk full');
      written.push(next);
    },
  });
  return {
    manager,
    written,
    setBusy: (value) => {
      busy = value;
    },
    failWrites: (value) => {
      failing = value;
    },
  };
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 's02-workspace-'));
  fixtureA = join(configDir, 'fixture-a');
  fixtureB = join(configDir, 'fixture-b');
  await mkdir(fixtureA);
  await mkdir(fixtureB);
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe('WorkspaceManager.add', () => {
  it('stores the resolved real path with the default queue policy', async () => {
    const { manager } = setup();

    const record = await manager.add({
      path: fixtureA,
      displayName: 'Fixture Alpha',
    });

    expect(record.workspaceId).toMatch(/^ws_/);
    expect(record.rootPath).toBe(await realpath(fixtureA));
    expect(record.displayName).toBe('Fixture Alpha');
    expect(record.policy.perSessionQueueLimit).toBe(20);
  });

  it('rejects the same real path twice, including through a symlink', async () => {
    const { manager } = setup();
    await manager.add({ path: fixtureA, displayName: 'Fixture Alpha' });
    const link = join(configDir, 'fixture-a-link');
    await symlink(fixtureA, link);

    await expect(
      manager.add({ path: link, displayName: 'Fixture Alpha Link' }),
    ).rejects.toThrow('INVALID_MESSAGE');
  });

  it('rejects more than 50 workspaces', async () => {
    const { manager } = setup();
    for (let index = 0; index < 50; index += 1) {
      const dir = join(configDir, `fixture-${index}`);
      await mkdir(dir);
      await manager.add({ path: dir, displayName: `Workspace ${index}` });
    }
    await mkdir(join(configDir, 'fixture-extra'));

    await expect(
      manager.add({
        path: join(configDir, 'fixture-extra'),
        displayName: 'Workspace Extra',
      }),
    ).rejects.toThrow('TOO_MANY_WORKSPACES');
  });

  it('does not swap the in-memory list when the write fails', async () => {
    const { manager, failWrites } = setup();
    await manager.add({ path: fixtureA, displayName: 'Fixture Alpha' });
    failWrites(true);

    await expect(
      manager.add({ path: fixtureB, displayName: 'Fixture Beta' }),
    ).rejects.toBeDefined();
    expect(manager.list()).toHaveLength(1);
  });
});

describe('WorkspaceManager.list and rename', () => {
  it('never exposes the real path in summaries', async () => {
    const { manager } = setup();
    await manager.add({ path: fixtureA, displayName: 'Fixture Alpha' });

    const [summary] = manager.list();

    expect(summary).toEqual({
      workspaceId: expect.stringMatching(/^ws_/),
      displayName: 'Fixture Alpha',
    });
    expect(JSON.stringify(manager.list())).not.toContain(fixtureA);
  });

  it('renames without changing id or path', async () => {
    const { manager, written } = setup();
    const record = await manager.add({
      path: fixtureA,
      displayName: 'Fixture Alpha',
    });

    const renamed = await manager.rename(record.workspaceId, '  Alpha 2  ');

    expect(renamed).toEqual({
      workspaceId: record.workspaceId,
      displayName: 'Alpha 2',
    });
    expect(written.at(-1)?.workspaces[0]?.rootPath).toBe(record.rootPath);
    expect(written.at(-1)?.workspaces[0]?.workspaceId).toBe(record.workspaceId);
  });
});

describe('WorkspaceManager.remove and assertUsable', () => {
  it('serializes removal against workspace usage without deleting files', async () => {
    const { manager, setBusy } = setup();
    const record = await manager.add({
      path: fixtureA,
      displayName: 'Fixture Alpha',
    });

    setBusy(true);
    await expect(manager.remove(record.workspaceId)).rejects.toThrow(
      'WORKSPACE_BUSY',
    );
    expect(manager.list()).toHaveLength(1);

    setBusy(false);
    await manager.remove(record.workspaceId);

    expect(manager.list()).toHaveLength(0);
    expect(() => manager.assertUsable(record.workspaceId)).toThrow(
      'WORKSPACE_NOT_ALLOWED',
    );
    expect((await stat(fixtureA)).isDirectory()).toBe(true);
  });

  it('distinguishes an unknown id from a removed id', async () => {
    const { manager } = setup();
    const record = await manager.add({
      path: fixtureA,
      displayName: 'Fixture Alpha',
    });
    await manager.remove(record.workspaceId);

    expect(() => manager.assertUsable('ws_missing')).toThrow(
      'WORKSPACE_NOT_FOUND',
    );
    expect(() => manager.assertUsable(record.workspaceId)).toThrow(
      'WORKSPACE_NOT_ALLOWED',
    );
  });

  it('rejects a removed root path that is deleted before the run starts', async () => {
    const { manager } = setup();
    const record = await manager.add({
      path: fixtureA,
      displayName: 'Fixture Alpha',
    });
    await rm(fixtureA, { recursive: true });

    expect(() => manager.assertUsable(record.workspaceId)).toThrow(
      'WORKSPACE_NOT_ALLOWED',
    );
  });

  it('generates a new id when the same path is added again', async () => {
    const { manager } = setup();
    const first = await manager.add({
      path: fixtureA,
      displayName: 'Fixture Alpha',
    });
    await manager.remove(first.workspaceId);

    const second = await manager.add({
      path: fixtureA,
      displayName: 'Fixture Alpha',
    });

    expect(second.workspaceId).not.toBe(first.workspaceId);
    expect(() => manager.assertUsable(first.workspaceId)).toThrow(
      'WORKSPACE_NOT_ALLOWED',
    );
  });
});