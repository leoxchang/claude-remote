import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockManagedRunDriver } from '../src/adapter/mock-managed-run-driver.js';
import { TerminalRunStatus } from '../src/domain/types.js';
import { AgentConfigV3 } from '../src/config/config-v3.js';
import { AdapterEvent } from '../src/events/adapter-events.js';
import { EventJournal } from '../src/events/journal.js';
import { EventNormalizer } from '../src/events/normalizer.js';
import { ManagedRunController } from '../src/run/run-controller.js';
import { RunScheduler } from '../src/run/run-scheduler.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';

let configDir: string;
let workspaceDir: string;

interface Harness {
  controller: ManagedRunController;
  scheduler: RunScheduler;
  sessions: SessionRegistry;
  driver: MockManagedRunDriver;
  journal: EventJournal;
  workspaceId: string;
  sessionId: string;
}

async function setup(
  options: { interruptTimeoutMs?: number } = {},
): Promise<Harness> {
  const config: AgentConfigV3 = {
    version: 3,
    desktopId: 'desktop_test',
    workspaces: [
      {
        workspaceId: 'ws_alpha',
        displayName: 'Fixture Alpha',
        rootPath: await realpath(workspaceDir),
        createdAt: 1_762_432_800_000,
        policy: {
          perSessionQueueLimit: 20,
          mobileApprovalMode: 'deny',
        },
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
  let sessionCounter = 0;
  const sessions = new SessionRegistry({
    now: () => 1_762_432_800_000,
    generateId: () => {
      sessionCounter += 1;
      return `session_${sessionCounter}`;
    },
  });
  const driver = new MockManagedRunDriver();
  const journal = new EventJournal();
  let runCounter = 0;
  const scheduler = new RunScheduler({
    sessions,
    workspaces,
    journal,
    driver,
    now: () => 1_762_432_800_000,
    generateRunId: () => {
      runCounter += 1;
      return `run_${runCounter}`;
    },
  });
  const controller = new ManagedRunController({
    scheduler,
    sessions,
    normalizer: new EventNormalizer(journal),
    ...(options.interruptTimeoutMs === undefined
      ? {}
      : { interruptTimeoutMs: options.interruptTimeoutMs }),
  });
  const session = sessions.create({ workspaceId: 'ws_alpha' });
  return {
    controller,
    scheduler,
    sessions,
    driver,
    journal,
    workspaceId: 'ws_alpha',
    sessionId: session.sessionId,
  };
}

function initEvent(sessionId: string, runId: string, claudeSessionId: string): AdapterEvent {
  return { kind: 'init', sessionId, runId, claudeSessionId };
}

function resultEvent(
  sessionId: string,
  runId: string,
  status: TerminalRunStatus,
): AdapterEvent {
  return { kind: 'runResult', sessionId, runId, status };
}

async function waitForTerminal(
  harness: Harness,
  sessionId: string,
  runId: string,
  timeoutMs = 2_000,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = harness.sessions
      .get(sessionId)
      .runsById.get(runId)?.status;
    if (
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'interrupted'
    ) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('run did not reach a terminal state');
}

function journalTypes(harness: Harness, sessionId: string): string[] {
  return harness.journal.recent(sessionId, 100).map((event) => event.type);
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 's02-controller-'));
  workspaceDir = join(configDir, 'fixture-a');
  await mkdir(workspaceDir);
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe('ManagedRunController', () => {
  it('cancels starting before init without inventing a Claude session mapping', async () => {
    const harness = await setup();
    harness.driver.interruptBehavior = 'cancelled';
    const accepted = await harness.controller.sendPrompt(
      harness.sessionId,
      'first',
      'cmd_1',
      'trace_1',
    );
    expect(accepted.status).toBe('starting');

    await harness.controller.cancel(harness.sessionId, accepted.runId);
    expect(await waitForTerminal(harness, harness.sessionId, accepted.runId)).toBe(
      'cancelled',
    );

    harness.driver.emit(
      accepted.runId,
      initEvent(harness.sessionId, accepted.runId, 'claude_late'),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.sessions.get(harness.sessionId).claudeSessionId).toBeNull();
    expect(journalTypes(harness, harness.sessionId).at(-1)).toBe('run.completed');
  });

  it('records the Claude id and resumes it in the next run', async () => {
    const harness = await setup();
    const first = await harness.controller.sendPrompt(
      harness.sessionId,
      'first',
      'cmd_1',
      'trace_1',
    );
    harness.driver.emit(
      first.runId,
      initEvent(harness.sessionId, first.runId, 'claude_1'),
    );
    harness.driver.emit(
      first.runId,
      resultEvent(harness.sessionId, first.runId, 'succeeded'),
    );
    expect(await waitForTerminal(harness, harness.sessionId, first.runId)).toBe(
      'succeeded',
    );
    expect(harness.sessions.get(harness.sessionId).claudeSessionId).toBe(
      'claude_1',
    );

    await harness.controller.sendPrompt(
      harness.sessionId,
      'second',
      'cmd_2',
      'trace_2',
    );

    expect(harness.driver.started[1]?.claudeSessionId).toBe('claude_1');
  });

  it('closes and marks interrupted when no terminal event arrives in time', async () => {
    const harness = await setup({ interruptTimeoutMs: 5 });
    harness.driver.interruptBehavior = 'silent';
    const accepted = await harness.controller.sendPrompt(
      harness.sessionId,
      'first',
      'cmd_1',
      'trace_1',
    );

    await harness.controller.cancel(harness.sessionId, accepted.runId);

    expect(
      await waitForTerminal(harness, harness.sessionId, accepted.runId),
    ).toBe('interrupted');
    expect(harness.driver.closedRunIds).toContain(accepted.runId);
  });

  it('does not interrupt twice for a repeated cancel', async () => {
    const harness = await setup();
    harness.driver.interruptBehavior = 'silent';
    const accepted = await harness.controller.sendPrompt(
      harness.sessionId,
      'first',
      'cmd_1',
      'trace_1',
    );

    await harness.controller.cancel(harness.sessionId, accepted.runId);
    const second = await harness.controller.cancel(
      harness.sessionId,
      accepted.runId,
    );

    expect(second.status).toBe('cancelling');
    expect(
      harness.driver.interruptCalls.filter((runId) => runId === accepted.runId),
    ).toHaveLength(1);
  });

  it('keeps another session running while one is cancelled', async () => {
    const harness = await setup();
    harness.driver.interruptBehavior = 'cancelled';
    const other = harness.sessions.create({ workspaceId: harness.workspaceId });
    const first = await harness.controller.sendPrompt(
      harness.sessionId,
      'first',
      'cmd_1',
      'trace_1',
    );
    const second = await harness.controller.sendPrompt(
      other.sessionId,
      'second',
      'cmd_2',
      'trace_2',
    );

    await harness.controller.cancel(harness.sessionId, first.runId);
    await waitForTerminal(harness, harness.sessionId, first.runId);

    harness.driver.emit(
      second.runId,
      { kind: 'textDelta', sessionId: other.sessionId, runId: second.runId, assistantMessageId: 'm1', contentBlockIndex: 0, text: 'alive' },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(
      harness.sessions.get(other.sessionId).runsById.get(second.runId)?.status,
    ).toBe('running');
    expect(journalTypes(harness, other.sessionId)).toContain('message.delta');
  });

  it('fails the run when the Claude id conflicts and keeps the original mapping', async () => {
    const harness = await setup();
    const first = await harness.controller.sendPrompt(
      harness.sessionId,
      'first',
      'cmd_1',
      'trace_1',
    );
    harness.driver.emit(
      first.runId,
      initEvent(harness.sessionId, first.runId, 'claude_1'),
    );
    harness.driver.emit(
      first.runId,
      resultEvent(harness.sessionId, first.runId, 'succeeded'),
    );
    await waitForTerminal(harness, harness.sessionId, first.runId);

    const second = await harness.controller.sendPrompt(
      harness.sessionId,
      'second',
      'cmd_2',
      'trace_2',
    );
    harness.driver.emit(
      second.runId,
      initEvent(harness.sessionId, second.runId, 'claude_2'),
    );

    expect(
      await waitForTerminal(harness, harness.sessionId, second.runId),
    ).toBe('failed');
    expect(harness.sessions.get(harness.sessionId).claudeSessionId).toBe(
      'claude_1',
    );
  });

  it('drops late events from an old generation', async () => {
    const harness = await setup();
    const first = await harness.controller.sendPrompt(
      harness.sessionId,
      'first',
      'cmd_1',
      'trace_1',
    );
    harness.driver.emit(
      first.runId,
      resultEvent(harness.sessionId, first.runId, 'succeeded'),
    );
    await waitForTerminal(harness, harness.sessionId, first.runId);
    const before = journalTypes(harness, harness.sessionId).length;

    harness.driver.emit(first.runId, {
      kind: 'textDelta',
      sessionId: harness.sessionId,
      runId: first.runId,
      assistantMessageId: 'm_late',
      contentBlockIndex: 0,
      text: 'late',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(journalTypes(harness, harness.sessionId)).toHaveLength(before);
  });

  it('removes queued runs without calling the driver', async () => {
    const harness = await setup();
    const first = await harness.controller.sendPrompt(
      harness.sessionId,
      'first',
      'cmd_1',
      'trace_1',
    );
    const second = await harness.controller.sendPrompt(
      harness.sessionId,
      'second',
      'cmd_2',
      'trace_2',
    );

    const removed = await harness.controller.removeQueued(
      harness.sessionId,
      second.runId,
    );

    expect(removed.removed).toBe(true);
    expect(harness.driver.startedRunIds()).toEqual([first.runId]);
    expect(journalTypes(harness, harness.sessionId)).toContain('run.completed');
  });
});