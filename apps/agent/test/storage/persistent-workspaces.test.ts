import { mkdtempSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentDatabase } from '../../src/storage/database.js';
import { SqliteWorkspaceRepository } from '../../src/storage/repositories/workspace-repository.js';
import { WorkspaceManager } from '../../src/workspace/workspace-manager.js';
import { WorkspaceRecord } from '../../src/workspace/workspace-types.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 's04-workspaces-'));
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const repository = new SqliteWorkspaceRepository(db.uow);
  const manager = new WorkspaceManager({ repository });
  return { dir, db, repository, manager };
}

function record(id: string, rootPath: string): WorkspaceRecord {
  return {
    workspaceId: id,
    displayName: `Fixture ${id}`,
    rootPath,
    createdAt: 1_762_432_800_000,
    policy: { perSessionQueueLimit: 20, mobileApprovalMode: 'deny' },
  };
}

describe('SqliteWorkspaceRepository', () => {
  it('persists records, hides removed projects and survives reopen', () => {
    const first = fixture();
    first.repository.insert(record('ws_a', '/tmp/a'));
    first.repository.insert(record('ws_b', '/tmp/b'));
    expect(first.repository.list().map((item) => item.workspaceId)).toEqual([
      'ws_a',
      'ws_b',
    ]);
    first.repository.update({
      ...record('ws_a', '/tmp/a'),
      displayName: 'Renamed',
      policy: { perSessionQueueLimit: 5, mobileApprovalMode: 'allow_once' },
    });
    expect(first.repository.get('ws_a')).toMatchObject({
      displayName: 'Renamed',
      policy: { perSessionQueueLimit: 5, mobileApprovalMode: 'allow_once' },
    });
    first.repository.remove('ws_b', 2);
    expect(first.repository.get('ws_b')).toBeUndefined();
    expect(first.repository.isRemoved('ws_b')).toBe(true);
    first.db.close();

    const reopened = AgentDatabase.open(join(first.dir, 'agent.sqlite3'));
    try {
      const repository = new SqliteWorkspaceRepository(reopened.uow);
      expect(repository.list().map((item) => item.workspaceId)).toEqual(['ws_a']);
      expect(repository.isRemoved('ws_b')).toBe(true);
    } finally {
      reopened.close();
    }
  });
});

describe('WorkspaceManager on SQLite', () => {
  it('adds, lists without rootPath, renames, sets approval and removes', async () => {
    const context = fixture();
    try {
      const project = mkdtempSync(join(tmpdir(), 's04-project-'));
      const added = await context.manager.add({
        path: project,
        displayName: 'Project',
      });
      expect(added.rootPath).toBe(realpathSync(project));

      const summary = context.manager.list()[0];
      expect(summary?.displayName).toBe('Project');
      expect(JSON.stringify(summary)).not.toContain('rootPath');

      await context.manager.rename(added.workspaceId, 'Renamed');
      expect(context.manager.list()[0]?.displayName).toBe('Renamed');

      context.manager.setApprovalMode(added.workspaceId, 'allow_once');
      expect(context.manager.approvalMode(added.workspaceId)).toBe('allow_once');
      expect(context.repository.get(added.workspaceId)).toMatchObject({
        policy: { mobileApprovalMode: 'allow_once' },
      });

      await context.manager.remove(added.workspaceId);
      expect(context.manager.list()).toEqual([]);
      expect(() => context.manager.assertUsable(added.workspaceId)).toThrow(
        /WORKSPACE_NOT_ALLOWED/,
      );
      // 移除后同一路径可以重新添加。
      const readded = await context.manager.add({
        path: project,
        displayName: 'Again',
      });
      expect(readded.workspaceId).not.toBe(added.workspaceId);
    } finally {
      context.db.close();
    }
  });

  it('rejects duplicate paths and fails when the real path is replaced', async () => {
    const context = fixture();
    try {
      const project = mkdtempSync(join(tmpdir(), 's04-project-'));
      const added = await context.manager.add({
        path: project,
        displayName: 'Project',
      });
      await expect(
        context.manager.add({ path: project, displayName: 'Duplicate' }),
      ).rejects.toThrow(/INVALID_MESSAGE/);

      renameSync(project, `${project}-moved`);
      expect(() => context.manager.assertUsable(added.workspaceId)).toThrow(
        /WORKSPACE_NOT_ALLOWED/,
      );
    } finally {
      context.db.close();
    }
  });

  it('blocks remove while the workspace is busy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's04-workspaces-'));
    const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
    const repository = new SqliteWorkspaceRepository(db.uow);
    repository.insert(record('ws_a', '/tmp/a'));
    const manager = new WorkspaceManager({
      repository,
      usage: { hasActiveOrQueued: (workspaceId) => workspaceId === 'ws_a' },
    });
    try {
      await expect(manager.remove('ws_a')).rejects.toThrow(/WORKSPACE_BUSY/);
      expect(repository.get('ws_a')).toBeDefined();
    } finally {
      db.close();
    }
  });
});