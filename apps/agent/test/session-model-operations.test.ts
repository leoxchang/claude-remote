import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentError } from '../src/command/errors.js';
import { DurableEventJournal } from '../src/events/durable-event-journal.js';
import { ModelCatalogService, ModelOption } from '../src/model/model-catalog.js';
import { DurableRunController } from '../src/run/durable-run-controller.js';
import { DurableRunScheduler } from '../src/run/durable-run-scheduler.js';
import { PromptAdmission } from '../src/run/prompt-admission.js';
import { DurableAgentOperations } from '../src/app/durable-agent-operations.js';
import { DurablePermissionBroker } from '../src/approval/durable-permission-broker.js';
import { DurableApprovalStore } from '../src/approval/durable-approval-store.js';
import { AgentDatabase } from '../src/storage/database.js';
import { RunRepository } from '../src/storage/repositories/run-repository.js';
import {
  SessionRepository,
  StoredSession,
} from '../src/storage/repositories/session-repository.js';
import { SqliteWorkspaceRepository } from '../src/storage/repositories/workspace-repository.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';

const NOW = 1_762_432_800_000;

const MODELS: ModelOption[] = [
  { value: 'opus', displayName: 'Opus', description: 'Deepest reasoning' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Best coding' },
];

/** 假目录服务；可注入失败并记录查询过的 cwd。 */
class FakeCatalog implements ModelCatalogService {
  failure: Error | null = null;
  readonly cwds: string[] = [];

  async list(cwd: string): Promise<ModelOption[]> {
    this.cwds.push(cwd);
    if (this.failure !== null) throw this.failure;
    return MODELS;
  }
}

/** 目录查询挂起的假服务；release() 之前 list() 不返回，便于插入并发事件。 */
class BlockingCatalog implements ModelCatalogService {
  private releaseGate: () => void = () => {};
  private markStarted: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });
  private readonly startedSignal = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async list(): Promise<ModelOption[]> {
    this.markStarted();
    await this.gate;
    return MODELS;
  }

  /** 等待 list() 开始挂起。 */
  waitUntilStarted(): Promise<void> {
    return this.startedSignal;
  }

  release(): void {
    this.releaseGate();
  }
}

interface Harness<T extends ModelCatalogService = FakeCatalog> {
  db: AgentDatabase;
  operations: DurableAgentOperations;
  catalog: T;
  journal: DurableEventJournal;
  sessions: SessionRepository;
  workspaceRoot: string;
  tempDirs: string[];
}

function session(sessionId: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId,
    workspaceId: 'ws_1',
    claudeSessionId: null,
    title: 'One',
    lifecycle: 'active',
    status: 'idle',
    lastSeq: 0,
    retentionFloor: 0,
    createdAt: 1,
    lastActivityAt: 1,
    archivedAt: null,
    model: null,
    ...overrides,
  };
}

let harnesses: Harness[] = [];

function makeHarness(options: { runningRunFor?: string } = {}): Harness {
  return makeHarnessWithCatalog(new FakeCatalog(), options);
}

function makeHarnessWithCatalog<T extends ModelCatalogService>(
  catalog: T,
  options: { runningRunFor?: string } = {},
): Harness<T> {
  const dir = mkdtempSync(join(tmpdir(), 's05-session-model-'));
  const root = mkdtempSync(join(tmpdir(), 's05-session-model-ws-'));
  const workspaceRoot = realpathSync(root);
  const db = AgentDatabase.open(join(dir, 'agent.sqlite3'));
  const sessions = new SessionRepository(db.uow);
  const journal = new DurableEventJournal(db.uow, { now: () => NOW });
  const workspaces = new WorkspaceManager({
    repository: new SqliteWorkspaceRepository(db.uow),
  });
  db.immediate((tx) => {
    tx.prepare(
      "INSERT INTO workspaces (workspaceId, displayName, rootPath, perSessionQueueLimit, mobileApprovalMode, createdAt) VALUES ('ws_1','W',?,20,'deny',1)",
    ).run(workspaceRoot);
    sessions.create(session('s1'));
    sessions.create(
      session('s_arch', {
        lifecycle: 'archived',
        status: 'archived',
        archivedAt: NOW,
      }),
    );
  });
  const runs = {
    countBySessionStatus: () => 0,
    listByStatus: (status: string) =>
      status === 'running' && options.runningRunFor !== undefined
        ? [
            {
              runId: 'run_1',
              sessionId: options.runningRunFor,
              status: 'running',
            },
          ]
        : [],
  } as unknown as RunRepository;
  const operations = new DurableAgentOperations({
    workspaces,
    sessions,
    runs,
    scheduler: {} as unknown as DurableRunScheduler,
    controller: {} as unknown as DurableRunController,
    admission: {} as unknown as PromptAdmission,
    broker: {} as unknown as DurablePermissionBroker,
    approvals: {} as unknown as DurableApprovalStore,
    journal,
    models: catalog,
    now: () => NOW,
  });
  return {
    db,
    operations,
    catalog,
    journal,
    sessions,
    workspaceRoot,
    tempDirs: [dir, root],
  };
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.db.close();
    for (const dir of harness.tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('DurableAgentOperations session model', () => {
  it('persists the model and returns it in the summary', async () => {
    const { db, operations, catalog } = makeHarness();

    const summary = await operations.setSessionModel('s1', 'opus');

    expect(summary.model).toBe('opus');
    expect(summary.status).toBe('idle');
    expect(catalog.cwds).toHaveLength(1);
    expect(sessionsModel(db)).toBe('opus');
  });

  it('keeps the seq of an event appended while the catalog loads', async () => {
    const catalog = new BlockingCatalog();
    const { operations, journal, sessions } = makeHarnessWithCatalog(catalog);

    const pending = operations.setSessionModel('s1', 'opus');
    await catalog.waitUntilStarted();

    // 目录查询挂起期间时间线推进；写回不能回滚 lastSeq。
    const appended = journal.commit((tx, append) =>
      append({
        sessionId: 's1',
        type: 'session.status',
        payload: { state: 'idle', title: 'One' },
      }),
    );
    expect(appended.events[0]?.seq).toBe(1);

    catalog.release();
    const summary = await pending;

    expect(summary.model).toBe('opus');
    expect(summary.status).toBe('idle');
    expect(sessions.get('s1')?.model).toBe('opus');
    expect(sessions.get('s1')?.lastSeq).toBe(2);
    const statuses = journal
      .recent('s1', 10)
      .filter((event) => event.type === 'session.status');
    expect(statuses[0]?.seq).toBe(1);
    expect(statuses.at(-1)?.payload).toEqual({
      state: 'idle',
      status: 'idle',
      title: 'One',
      model: 'opus',
    });
  });

  it('rejects SESSION_ARCHIVED when the session is archived while the catalog loads', async () => {
    const catalog = new BlockingCatalog();
    const { db, operations, sessions } = makeHarnessWithCatalog(catalog);

    const pending = operations.setSessionModel('s1', 'opus');
    await catalog.waitUntilStarted();
    const session = sessions.get('s1');
    expect(session).toBeDefined();
    sessions.update({
      ...(session as StoredSession),
      lifecycle: 'archived',
      status: 'archived',
      archivedAt: NOW,
    });

    catalog.release();

    await expect(pending).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' });
    expect(sessionsModel(db)).toBeNull();
  });

  it('broadcasts a truthful status while a run is active', async () => {
    const { operations, journal } = makeHarness({ runningRunFor: 's1' });

    const summary = await operations.setSessionModel('s1', 'opus');

    expect(summary.status).toBe('running');
    expect(summary.activeRunId).toBe('run_1');
    const statuses = journal
      .recent('s1', 10)
      .filter((event) => event.type === 'session.status');
    expect(statuses.at(-1)?.payload).toEqual({
      state: 'running',
      status: 'running',
      title: 'One',
      model: 'opus',
    });
  });

  it('clears the model back to null without consulting the catalog', async () => {
    const { operations, catalog } = makeHarness();

    await operations.setSessionModel('s1', 'opus');
    const summary = await operations.setSessionModel('s1', null);

    expect(summary.model).toBeNull();
    expect(catalog.cwds).toHaveLength(1);
  });

  it('rejects archived sessions with SESSION_ARCHIVED', async () => {
    const { operations } = makeHarness();

    await expect(operations.setSessionModel('s_arch', 'opus')).rejects.toMatchObject({
      code: 'SESSION_ARCHIVED',
    });
  });

  it('rejects values outside the catalog with INVALID_MESSAGE', async () => {
    const { db, operations, sessions } = makeHarness();

    await expect(
      operations.setSessionModel('s1', 'not-in-catalog'),
    ).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(sessions.get('s1')?.model).toBeNull();
  });

  it('maps catalog failures to retryable INTERNAL_ERROR', async () => {
    const { operations, catalog } = makeHarness();
    catalog.failure = new Error('sdk unavailable');

    await expect(operations.setSessionModel('s1', 'opus')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: true,
    });
  });

  it('lists models for a workspace and rejects unknown workspaces', async () => {
    const { operations, catalog, workspaceRoot } = makeHarness();

    const models = await operations.listModels('ws_1');

    expect(models).toEqual(MODELS);
    expect(catalog.cwds).toEqual([workspaceRoot]);
    await expect(operations.listModels('ws_missing')).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
    });
  });

  it('rethrows AgentError from the catalog unchanged', async () => {
    const { operations, catalog } = makeHarness();
    catalog.failure = new AgentError('WORKSPACE_NOT_ALLOWED');

    await expect(operations.listModels('ws_1')).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_ALLOWED',
      retryable: false,
    });
  });
});

function sessionsModel(db: AgentDatabase): string | null | undefined {
  const row = db.connection
    .prepare('SELECT model FROM sessions WHERE sessionId = ?')
    .get('s1') as { model: string | null } | undefined;
  return row?.model;
}
