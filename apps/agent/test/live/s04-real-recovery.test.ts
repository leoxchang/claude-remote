import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentSdkAdapter } from '../../src/adapter/agent-sdk-adapter.js';
import { AdapterRegistry } from '../../src/adapter/adapter-registry.js';
import {
  ManagedRunDriver,
  ManagedRunHandle,
  ManagedRunStart,
} from '../../src/adapter/managed-run-driver.js';
import { PermissionGate } from '../../src/adapter/managed-run-driver.js';
import { DurableEventJournal } from '../../src/events/durable-event-journal.js';
import { DurableJournalAdapter } from '../../src/events/durable-journal-adapter.js';
import { EventNormalizer } from '../../src/events/normalizer.js';
import { DurableRunController } from '../../src/run/durable-run-controller.js';
import { DurableRunScheduler } from '../../src/run/durable-run-scheduler.js';
import { PromptAdmission, PROMPT_TTL_MS } from '../../src/run/prompt-admission.js';
import { AgentDatabase } from '../../src/storage/database.js';
import { PersistentCommandExecutor } from '../../src/storage/persistent-command-executor.js';
import { RunRepository, StoredRun } from '../../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../../src/storage/repositories/session-repository.js';
import { SqliteWorkspaceRepository } from '../../src/storage/repositories/workspace-repository.js';
import { StartupRecovery } from '../../src/storage/startup-recovery.js';
import { ApprovalRepository } from '../../src/storage/repositories/approval-repository.js';
import { runCrashScenario } from './s04-crash-harness.js';

const TERMINAL_TIMEOUT_MS = 300_000;
const NOW = 1_762_432_800_000;

const DENY_GATE: PermissionGate = {
  request: (_runId, request) =>
    Promise.resolve({
      behavior: 'deny',
      message: 'approval not used in S04 live test',
      interrupt: false,
      toolUseID: request.toolUseID,
    }),
};

class RecordingDriver implements ManagedRunDriver {
  readonly starts: ManagedRunStart[] = [];
  constructor(private readonly inner: ManagedRunDriver) {}

  startRun(input: ManagedRunStart): ManagedRunHandle {
    this.starts.push(input);
    return this.inner.startRun(input);
  }
}

function queuedRun(runId: string, sessionId: string, text: string): StoredRun {
  return {
    runId,
    sessionId,
    workspaceId: 'ws_1',
    deviceId: 'device_1',
    commandId: `cmd_${runId}`,
    traceId: `trace_${runId}`,
    status: 'queued',
    promptText: text,
    promptExpiresAt: Date.now() + PROMPT_TTL_MS,
    enqueueOrder: 1,
    recoveryGeneration: 0,
    pendingApprovalCount: 0,
    outcomeUnknown: false,
    eventTailMayBeIncomplete: false,
    recoveryReason: null,
    enqueuedAt: NOW,
    startedAt: null,
    endedAt: null,
    errorSummary: null,
  };
}

async function waitForTerminal(
  runs: RunRepository,
  runId: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < TERMINAL_TIMEOUT_MS) {
    const run = runs.get(runId);
    if (
      run !== undefined &&
      ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout waiting for ${runId}`);
}

interface Harness {
  db: AgentDatabase;
  sessions: SessionRepository;
  runs: RunRepository;
  scheduler: DurableRunScheduler;
  driver: RecordingDriver;
  close(): Promise<void>;
}

function harness(
  path: string,
  options: { fresh: boolean; project: string },
): Harness {
  const db = AgentDatabase.open(path);
  const sessions = new SessionRepository(db.uow);
  const runs = new RunRepository(db.uow);
  const workspaces = new SqliteWorkspaceRepository(db.uow);
  const journal = new DurableEventJournal(db.uow);
  const normalizer = new EventNormalizer(new DurableJournalAdapter(journal));
  const driver = new RecordingDriver(new AgentSdkAdapter());
  const scheduler = new DurableRunScheduler({
    uow: db.uow,
    sessions,
    runs,
    workspaces,
    journal,
    driver,
    registry: new AdapterRegistry(),
    permissionGate: DENY_GATE,
  });
  const controller = new DurableRunController({
    scheduler,
    sessions,
    normalizer,
  });
  void controller;
  if (options.fresh) {
    db.immediate((tx) => {
      tx.prepare(
        "INSERT INTO workspaces (workspaceId, displayName, rootPath, perSessionQueueLimit, mobileApprovalMode, createdAt) VALUES ('ws_1','W',?,20,'deny',1)",
      ).run(options.project);
      sessions.create({
        sessionId: 's1',
        workspaceId: 'ws_1',
        claudeSessionId: null,
        title: 'Live',
        lifecycle: 'active',
        status: 'idle',
        lastSeq: 0,
        retentionFloor: 0,
        createdAt: 1,
        lastActivityAt: 1,
        archivedAt: null,
      });
    });
  }
  return {
    db,
    sessions,
    runs,
    scheduler,
    driver,
    async close() {
      db.close();
    },
  };
}

describe('S04 real recovery (live)', () => {
  it('rolls back an uncommitted crash and keeps a committed one', () => {
    const dir = mkdtempSync(join(tmpdir(), 's04-live-crash-'));
    const path = join(dir, 'agent.sqlite3');
    const db = AgentDatabase.open(path);
    try {
      db.immediate((tx) =>
        tx.exec('CREATE TABLE crash_marker (id TEXT PRIMARY KEY)'),
      );
      expect(runCrashScenario('before-commit', path)).toBe(9);
      const before = db.connection
        .prepare('SELECT count(*) AS total FROM crash_marker')
        .all();
      expect(before).toEqual([{ total: 0 }]);
      expect(runCrashScenario('after-commit', path)).toBe(0);
      const after = db.connection
        .prepare('SELECT count(*) AS total FROM crash_marker')
        .all();
      expect(after).toEqual([{ total: 1 }]);
    } finally {
      db.close();
    }
  });

  it('resumes the same Claude session only after an explicit new prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's04-live-'));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 's04-live-ws-')));
    const path = join(dir, 'agent.sqlite3');
    const first = harness(path, { fresh: true, project });

    first.runs.insert(
      queuedRun('run_1', 's1', 'Reply with exactly: S04_RESUME_ONE'),
    );
    first.scheduler.drain();
    await waitForTerminal(first.runs, 'run_1');
    expect(first.runs.get('run_1')?.status).toBe('succeeded');
    const claudeSessionId = first.sessions.get('s1')?.claudeSessionId;
    expect(claudeSessionId).toEqual(expect.any(String));
    await first.close();

    const recovered = AgentDatabase.open(path);
    const recovery = new StartupRecovery({
      uow: recovered.uow,
      journal: new DurableEventJournal(recovered.uow),
      runs: new RunRepository(recovered.uow),
      sessions: new SessionRepository(recovered.uow),
      approvals: new ApprovalRepository(recovered.uow),
    });
    const report = recovery.repair({ agentInstanceId: 'agent_after_restart' });
    expect(report.interruptedRuns).toEqual([]);
    recovered.close();

    const second = harness(path, { fresh: false, project });
    try {
      const workspaces = new SqliteWorkspaceRepository(second.db.uow);
      const journal = new DurableEventJournal(second.db.uow);
      const executor = new PersistentCommandExecutor({
        uow: second.db.uow,
        appender: journal,
      });
      const admission = new PromptAdmission({
        executor,
        sessions: second.sessions,
        runs: second.runs,
        workspaces,
        onAccepted: () => second.scheduler.drain(),
      });
      second.scheduler.drain();
      expect(second.driver.starts).toEqual([]);

      const accepted = admission.send({
        identity: {
          commandId: 'cmd_2',
          type: 'prompt.send',
          workspaceId: 'ws_1',
          sessionId: 's1',
          payload: { text: 'Reply with exactly: S04_RESUME_TWO' },
        },
        actor: { deviceId: 'device_1' },
        text: 'Reply with exactly: S04_RESUME_TWO',
        traceId: 'trace_2',
        now: Date.now(),
      }).result;
      expect(accepted.status).toBe('queued');
      second.scheduler.drain();
      await waitForTerminal(second.runs, accepted.runId);
      expect(second.runs.get(accepted.runId)?.status).toBe('succeeded');
      expect(second.driver.starts).toHaveLength(1);
      expect(second.driver.starts[0]?.claudeSessionId).toBe(claudeSessionId);
    } finally {
      await second.close();
    }
  });
});