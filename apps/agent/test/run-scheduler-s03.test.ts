import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockManagedRunDriver } from '../src/adapter/mock-managed-run-driver.js';
import { AgentConfigV3 } from '../src/config/config-v3.js';
import { EventJournal } from '../src/events/journal.js';
import { RunScheduler } from '../src/run/run-scheduler.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { toSessionSummary } from '../src/session/session-summary.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';

const FIXED_NOW = 1_762_432_800_000;

let configDir: string;
let workspaceDir: string;

interface Harness {
  scheduler: RunScheduler;
  sessions: SessionRegistry;
  journal: EventJournal;
  driver: MockManagedRunDriver;
  workspaceId: string;
}

async function setup(): Promise<Harness> {
  const config: AgentConfigV3 = {
    version: 3,
    desktopId: 'desktop_test',
    workspaces: [
      {
        workspaceId: 'ws_alpha',
        displayName: 'Fixture Alpha',
        rootPath: await realpath(workspaceDir),
        createdAt: FIXED_NOW,
        policy: { perSessionQueueLimit: 20, mobileApprovalMode: 'allow_once' },
      },
    ],
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: 'https://macbook-pro.tail0970fd.ts.net' },
  };
  const workspaces = new WorkspaceManager({
    configDir,
    config,
    writeConfig: () => undefined,
  });
  const sessions = new SessionRegistry({
    now: () => FIXED_NOW,
    generateId: (() => {
      let counter = 0;
      return () => {
        counter += 1;
        return `session_${counter}`;
      };
    })(),
  });
  const journal = new EventJournal();
  const driver = new MockManagedRunDriver();
  let runCounter = 0;
  const scheduler = new RunScheduler({
    sessions,
    workspaces,
    journal,
    driver,
    now: () => FIXED_NOW,
    generateRunId: () => {
      runCounter += 1;
      return `run_${runCounter}`;
    },
  });
  return {
    scheduler,
    sessions,
    journal,
    driver,
    workspaceId: 'ws_alpha',
  };
}

function enqueue(harness: Harness, sessionId: string, device = 'device_1') {
  return harness.scheduler.enqueue({
    sessionId,
    text: 'hello',
    commandId: `cmd_${sessionId}`,
    traceId: `trace_${sessionId}`,
    deviceId: device,
  });
}

function sessionStatusEvents(journal: EventJournal, sessionId: string) {
  return journal
    .recent(sessionId, 100)
    .filter((event) => event.type === 'session.status')
    .map((event) => event.payload as Record<string, unknown>);
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 's03-scheduler-'));
  workspaceDir = join(configDir, 'fixture-alpha');
  await mkdir(workspaceDir);
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe('RunScheduler waiting_approval', () => {
  it('enters waiting_approval on the first pending and returns to running at zero', async () => {
    const harness = await setup();
    const session = harness.sessions.create({ workspaceId: harness.workspaceId });
    const accepted = enqueue(harness, session.sessionId);

    expect(accepted.status).toBe('queued');
    harness.scheduler.setPendingApprovalCount(accepted.runId, 1);

    let active = harness.sessions.get(session.sessionId).activeRun;
    expect(active).toMatchObject({
      status: 'waiting_approval',
      pendingApprovalCount: 1,
      deviceId: 'device_1',
    });
    expect(toSessionSummary(harness.sessions.get(session.sessionId)).status).toBe(
      'waiting_approval',
    );
    expect(sessionStatusEvents(harness.journal, session.sessionId).at(-1)).toMatchObject(
      { state: 'waiting_approval', pendingApprovalCount: 1 },
    );

    harness.scheduler.setPendingApprovalCount(accepted.runId, 2);
    active = harness.sessions.get(session.sessionId).activeRun;
    expect(active?.pendingApprovalCount).toBe(2);
    expect(active?.status).toBe('waiting_approval');

    harness.scheduler.setPendingApprovalCount(accepted.runId, 1);
    expect(harness.sessions.get(session.sessionId).activeRun?.status).toBe(
      'waiting_approval',
    );

    harness.scheduler.setPendingApprovalCount(accepted.runId, 0);
    active = harness.sessions.get(session.sessionId).activeRun;
    expect(active?.status).toBe('running');
    expect(active?.pendingApprovalCount).toBe(0);
  });

  it('keeps occupying a slot while waiting and blocks the same session queue', async () => {
    const harness = await setup();
    const first = harness.sessions.create({ workspaceId: harness.workspaceId });
    const second = harness.sessions.create({ workspaceId: harness.workspaceId });

    const runA = enqueue(harness, first.sessionId);
    const runB = enqueue(harness, second.sessionId);
    harness.scheduler.setPendingApprovalCount(runA.runId, 1);

    expect(harness.scheduler.activeCount()).toBe(2);
    const queuedSameSession = enqueue(harness, first.sessionId);
    expect(queuedSameSession.status).toBe('queued');

    const third = harness.sessions.create({ workspaceId: harness.workspaceId });
    expect(enqueue(harness, third.sessionId).status).toBe('queued');

    harness.scheduler.beginCancel(first.sessionId, runA.runId);
    expect(harness.scheduler.activeCount()).toBe(2);
    expect(harness.sessions.get(second.sessionId).activeRun?.status).toBe(
      'starting',
    );
    expect(runB.runId).not.toBe(runA.runId);
  });

  it('exposes a bound approval context only for the active run', async () => {
    const harness = await setup();
    const session = harness.sessions.create({ workspaceId: harness.workspaceId });
    const accepted = enqueue(harness, session.sessionId);

    const context = harness.scheduler.approvalContext(accepted.runId);
    expect(context).toEqual({
      context: {
        workspaceId: 'ws_alpha',
        sessionId: session.sessionId,
        runId: accepted.runId,
        deviceId: 'device_1',
        workingDirectory: await realpath(workspaceDir),
      },
      acceptingApprovals: true,
    });
    expect(harness.scheduler.approvalContext('run_missing')).toBeNull();

    harness.scheduler.beginCancel(session.sessionId, accepted.runId);
    expect(harness.scheduler.approvalContext(accepted.runId)?.acceptingApprovals).toBe(
      false,
    );

    harness.scheduler.complete({
      sessionId: session.sessionId,
      runId: accepted.runId,
      status: 'cancelled',
    });
    expect(harness.scheduler.approvalContext(accepted.runId)).toBeNull();
  });
});