import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdapterRegistry } from '../src/adapter/adapter-registry.js';
import { MockManagedRunDriver } from '../src/adapter/mock-managed-run-driver.js';
import { AgentConfigV3 } from '../src/config/config-v3.js';
import { EventJournal } from '../src/events/journal.js';
import { RunScheduler } from '../src/run/run-scheduler.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';

let configDir: string;
let workspaceDir: string;
let sessionCounter = 0;

interface Harness {
  scheduler: RunScheduler;
  sessions: SessionRegistry;
  driver: MockManagedRunDriver;
  registry: AdapterRegistry;
  journal: EventJournal;
  workspaceId: string;
  sessionId: string;
}

async function setup(options: { queueLimit?: number } = {}): Promise<Harness> {
  sessionCounter = 0;
  const config = emptyConfig();
  config.workspaces = [
    {
      workspaceId: 'ws_alpha',
      displayName: 'Fixture Alpha',
      rootPath: await realpath(workspaceDir),
      createdAt: 1_762_432_800_000,
      policy: {
        perSessionQueueLimit: options.queueLimit ?? 20,
        mobileApprovalMode: 'deny',
      },
    },
  ];
  const workspaces = new WorkspaceManager({
    configDir,
    config,
    writeConfig: () => undefined,
  });
  const workspace = { workspaceId: 'ws_alpha' };
  const sessions = new SessionRegistry({
    now: () => 1_762_432_800_000,
    generateId: () => {
      sessionCounter += 1;
      return `session_${sessionCounter}`;
    },
  });
  const driver = new MockManagedRunDriver();
  const registry = new AdapterRegistry();
  const journal = new EventJournal();
  let runCounter = 0;
  const scheduler = new RunScheduler({
    sessions,
    workspaces,
    journal,
    driver,
    registry,
    now: () => 1_762_432_800_000,
    generateRunId: () => {
      runCounter += 1;
      return `run_${runCounter}`;
    },
  });
  const session = sessions.create({ workspaceId: workspace.workspaceId });
  return {
    scheduler,
    sessions,
    driver,
    registry,
    journal,
    workspaceId: workspace.workspaceId,
    sessionId: session.sessionId,
  };
}

function emptyConfig(): AgentConfigV3 {
  return {
    version: 3,
    desktopId: 'desktop_test',
    workspaces: [],
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: 'https://macbook-pro.tail0970fd.ts.net' },
  };
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 's02-scheduler-'));
  workspaceDir = join(configDir, 'fixture-a');
  await mkdir(workspaceDir);
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe('RunScheduler dual-slot dispatch', () => {
  it('skips a busy session head without blocking another session', async () => {
    const harness = await setup();
    const a1 = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'a1',
      commandId: 'cmd_a1',
      traceId: 'trace_a1',
    });
    const a2 = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'a2',
      commandId: 'cmd_a2',
      traceId: 'trace_a2',
    });
    const other = harness.sessions.create({ workspaceId: harness.workspaceId });
    const b1 = harness.scheduler.enqueue({
      sessionId: other.sessionId,
      deviceId: 'device_1',
      text: 'b1',
      commandId: 'cmd_b1',
      traceId: 'trace_b1',
    });
    const third = harness.sessions.create({ workspaceId: harness.workspaceId });
    const c1 = harness.scheduler.enqueue({
      sessionId: third.sessionId,
      deviceId: 'device_1',
      text: 'c1',
      commandId: 'cmd_c1',
      traceId: 'trace_c1',
    });

    expect([a1.status, b1.status, a2.status, c1.status]).toEqual([
      'starting',
      'starting',
      'queued',
      'queued',
    ]);
    expect(harness.driver.startedRunIds()).toEqual([a1.runId, b1.runId]);

    harness.scheduler.complete({
      sessionId: harness.sessionId,
      runId: a1.runId,
      status: 'succeeded',
    });

    expect(harness.driver.startedRunIds()).toEqual([a1.runId, b1.runId, a2.runId]);
    expect(harness.scheduler.activeCount()).toBe(2);
  });

  it('registers the handle before starting becomes visible', async () => {
    const harness = await setup();
    const accepted = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'hello',
      commandId: 'cmd_1',
      traceId: 'trace_1',
    });

    expect(accepted.status).toBe('starting');
    expect(harness.registry.get(accepted.runId)).not.toBeNull();
    expect(harness.driver.startedRunIds()).toEqual([accepted.runId]);

    const queued = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'later',
      commandId: 'cmd_2',
      traceId: 'trace_2',
    });
    expect(queued.status).toBe('queued');
    expect(harness.registry.get(queued.runId)).toBeNull();
  });

  it('moves activeRun from starting to running via markRunning', async () => {
    const harness = await setup();
    const accepted = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'hello',
      commandId: 'cmd_1',
      traceId: 'trace_1',
    });

    harness.scheduler.markRunning(harness.sessionId, accepted.runId);

    expect(
      harness.sessions.get(harness.sessionId).activeRun?.status,
    ).toBe('running');
  });

  it('counts cancelling against the global slot limit', async () => {
    const harness = await setup();
    const a1 = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'a1',
      commandId: 'cmd_a1',
      traceId: 'trace_a1',
    });
    const other = harness.sessions.create({ workspaceId: harness.workspaceId });
    const b1 = harness.scheduler.enqueue({
      sessionId: other.sessionId,
      deviceId: 'device_1',
      text: 'b1',
      commandId: 'cmd_b1',
      traceId: 'trace_b1',
    });
    const third = harness.sessions.create({ workspaceId: harness.workspaceId });
    const c1 = harness.scheduler.enqueue({
      sessionId: third.sessionId,
      deviceId: 'device_1',
      text: 'c1',
      commandId: 'cmd_c1',
      traceId: 'trace_c1',
    });

    const cancel = harness.scheduler.beginCancel(harness.sessionId, a1.runId);
    expect(cancel.outcome).toBe('started');
    expect(c1.status).toBe('queued');

    const again = harness.scheduler.beginCancel(harness.sessionId, a1.runId);
    expect(again.outcome).toBe('alreadyCancelling');

    harness.scheduler.complete({
      sessionId: harness.sessionId,
      runId: a1.runId,
      status: 'cancelled',
    });
    expect(harness.driver.startedRunIds()).toEqual([
      a1.runId,
      b1.runId,
      c1.runId,
    ]);
  });

  it('keeps same-session FIFO order', async () => {
    const harness = await setup();
    const first = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'one',
      commandId: 'cmd_1',
      traceId: 'trace_1',
    });
    const second = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'two',
      commandId: 'cmd_2',
      traceId: 'trace_2',
    });
    const third = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'three',
      commandId: 'cmd_3',
      traceId: 'trace_3',
    });

    harness.scheduler.complete({
      sessionId: harness.sessionId,
      runId: first.runId,
      status: 'succeeded',
    });
    expect(harness.scheduler.handle(second.runId)).not.toBeNull();
    expect(harness.scheduler.handle(third.runId)).toBeNull();
  });
});

describe('RunScheduler queue.remove', () => {
  it('removes a middle queued run and keeps the rest in order', async () => {
    const harness = await setup();
    const first = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'one',
      commandId: 'cmd_1',
      traceId: 'trace_1',
    });
    const second = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'two',
      commandId: 'cmd_2',
      traceId: 'trace_2',
    });
    const third = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'three',
      commandId: 'cmd_3',
      traceId: 'trace_3',
    });

    const removed = harness.scheduler.removeQueued(
      harness.sessionId,
      second.runId,
    );

    expect(removed).toEqual({
      sessionId: harness.sessionId,
      runId: second.runId,
      status: 'cancelled',
      removed: true,
    });
    expect(
      harness.scheduler.queuedRuns(harness.sessionId).map((run) => run.runId),
    ).toEqual([third.runId]);

    harness.scheduler.complete({
      sessionId: harness.sessionId,
      runId: first.runId,
      status: 'succeeded',
    });
    expect(harness.driver.startedRunIds()).toEqual([first.runId, third.runId]);
  });

  it('distinguishes active, terminal, foreign and unknown runs', async () => {
    const harness = await setup();
    const active = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'one',
      commandId: 'cmd_1',
      traceId: 'trace_1',
    });
    const queued = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'two',
      commandId: 'cmd_2',
      traceId: 'trace_2',
    });

    expect(() =>
      harness.scheduler.removeQueued(harness.sessionId, active.runId),
    ).toThrow('RUN_NOT_QUEUED');

    const other = harness.sessions.create({ workspaceId: harness.workspaceId });
    expect(() => harness.scheduler.removeQueued(other.sessionId, queued.runId)).toThrow(
      'RUN_SESSION_MISMATCH',
    );
    expect(() => harness.scheduler.removeQueued(other.sessionId, 'run_missing')).toThrow(
      'RUN_NOT_FOUND',
    );

    harness.scheduler.complete({
      sessionId: harness.sessionId,
      runId: active.runId,
      status: 'succeeded',
    });
    expect(() =>
      harness.scheduler.removeQueued(harness.sessionId, active.runId),
    ).toThrow('RUN_NOT_QUEUED');
  });
});

describe('RunScheduler limits and failures', () => {
  it('rejects a full per-session queue without writing a run', async () => {
    const harness = await setup({ queueLimit: 1 });
    harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'one',
      commandId: 'cmd_1',
      traceId: 'trace_1',
    });
    const second = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'two',
      commandId: 'cmd_2',
      traceId: 'trace_2',
    });

    expect(() =>
      harness.scheduler.enqueue({
        sessionId: harness.sessionId,
        deviceId: 'device_1',
        text: 'three',
        commandId: 'cmd_3',
        traceId: 'trace_3',
      }),
    ).toThrow('QUEUE_FULL');
    expect(harness.scheduler.queuedRuns(harness.sessionId)).toHaveLength(1);
    expect(second.status).toBe('queued');
  });

  it('rejects when the global queue limit is reached', async () => {
    const harness = await setup({ queueLimit: 20 });
    const sessions: string[] = [harness.sessionId];
    for (let index = 0; index < 4; index += 1) {
      sessions.push(
        harness.sessions.create({ workspaceId: harness.workspaceId }).sessionId,
      );
    }
    for (const sessionId of sessions) {
      for (let index = 0; index < 20; index += 1) {
        harness.scheduler.enqueue({
          sessionId,
      deviceId: 'device_1',
          text: `text-${index}`,
          commandId: `cmd_${sessionId}_${index}`,
          traceId: `trace_${sessionId}_${index}`,
        });
      }
    }
    const extra = harness.sessions.create({ workspaceId: harness.workspaceId });
    harness.scheduler.enqueue({
      sessionId: extra.sessionId,
      deviceId: 'device_1',
      text: 'fill-1',
      commandId: 'cmd_fill_1',
      traceId: 'trace_fill_1',
    });
    harness.scheduler.enqueue({
      sessionId: extra.sessionId,
      deviceId: 'device_1',
      text: 'fill-2',
      commandId: 'cmd_fill_2',
      traceId: 'trace_fill_2',
    });

    expect(() =>
      harness.scheduler.enqueue({
        sessionId: extra.sessionId,
        deviceId: 'device_1',
        text: 'overflow',
        commandId: 'cmd_overflow',
        traceId: 'trace_overflow',
      }),
    ).toThrow('QUEUE_FULL');
  });

  it('fails the run without a driver when the root path is gone at start', async () => {
    const harness = await setup();
    const blocker = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'blocker',
      commandId: 'cmd_blocker',
      traceId: 'trace_blocker',
    });
    const accepted = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'hello',
      commandId: 'cmd_1',
      traceId: 'trace_1',
    });
    expect(accepted.status).toBe('queued');
    await rm(workspaceDir, { recursive: true });

    harness.scheduler.complete({
      sessionId: harness.sessionId,
      runId: blocker.runId,
      status: 'succeeded',
    });

    expect(harness.driver.startedRunIds()).toEqual([blocker.runId]);
    expect(
      harness.sessions.get(harness.sessionId).runsById.get(accepted.runId)
        ?.status,
    ).toBe('failed');
    expect(harness.scheduler.activeCount()).toBe(0);
  });

  it('completes failed and frees the slot exactly once when the driver throws', async () => {
    const harness = await setup();
    harness.driver.failNextStart = true;

    const accepted = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'hello',
      commandId: 'cmd_1',
      traceId: 'trace_1',
    });

    expect(harness.scheduler.activeCount()).toBe(0);
    expect(
      harness.sessions.get(harness.sessionId).runsById.get(accepted.runId)
        ?.status,
    ).toBe('failed');

    const next = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'next',
      commandId: 'cmd_2',
      traceId: 'trace_2',
    });
    expect(next.status).toBe('starting');
  });

  it('clears queued text when a run reaches a terminal state', async () => {
    const harness = await setup();
    const accepted = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'secret prompt',
      commandId: 'cmd_1',
      traceId: 'trace_1',
    });

    harness.scheduler.complete({
      sessionId: harness.sessionId,
      runId: accepted.runId,
      status: 'succeeded',
    });

    const record = harness.sessions
      .get(harness.sessionId)
      .runsById.get(accepted.runId);
    expect(record?.text).toBeNull();
    expect(record?.endedAt).not.toBeNull();
  });

  it('reports active or queued usage per workspace', async () => {
    const harness = await setup();
    const accepted = harness.scheduler.enqueue({
      sessionId: harness.sessionId,
      deviceId: 'device_1',
      text: 'hello',
      commandId: 'cmd_1',
      traceId: 'trace_1',
    });

    expect(harness.scheduler.hasActiveOrQueued(harness.workspaceId)).toBe(true);
    harness.scheduler.complete({
      sessionId: harness.sessionId,
      runId: accepted.runId,
      status: 'succeeded',
    });
    expect(harness.scheduler.hasActiveOrQueued(harness.workspaceId)).toBe(false);
  });
});