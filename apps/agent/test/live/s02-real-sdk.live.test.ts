import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentSdkAdapter } from '../../src/adapter/agent-sdk-adapter.js';
import { AgentConfigV2, RunRecord } from '../../src/domain/types.js';
import { EventJournal } from '../../src/events/journal.js';
import { EventNormalizer } from '../../src/events/normalizer.js';
import { ManagedRunController } from '../../src/run/run-controller.js';
import { RunScheduler } from '../../src/run/run-scheduler.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { WorkspaceManager } from '../../src/workspace/workspace-manager.js';
import { startLiveRun } from './concurrency-harness.js';

const TERMINAL_TIMEOUT_MS = 300_000;
const FIXED_NOW = 1_762_432_800_000;

const RESUME_MARKER = 'S02_RESUME_MARKER_5D31';
const CROSS_A = 'S02_CROSS_A_91FA';
const CROSS_B = 'S02_CROSS_B_27C4';

function enumerationPrompt(marker: string): string {
  return [
    'Do not use any tools.',
    'Output the integers from 1 to 200, one per line.',
    `After the last integer, output exactly this line: ${marker}`,
  ].join('\n');
}

function longEnumerationPrompt(marker: string): string {
  return [
    'Do not use any tools.',
    'Output the integers from 1 to 2000, one per line.',
    `After the last integer, output exactly this line: ${marker}`,
  ].join('\n');
}

async function createFixture(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `s02-live-${label}-`));
}

function terminalStatus(runs: ReadonlyMap<string, RunRecord>, runId: string): string | undefined {
  return runs.get(runId)?.status;
}

async function waitForTerminal(
  sessions: SessionRegistry,
  sessionId: string,
  runId: string,
  timeoutMs = TERMINAL_TIMEOUT_MS,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = terminalStatus(sessions.get(sessionId).runsById, runId);
    if (
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'interrupted'
    ) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('run did not reach a terminal state');
}

interface Harness {
  controller: ManagedRunController;
  scheduler: RunScheduler;
  sessions: SessionRegistry;
  journal: EventJournal;
  workspaceId: string;
  roots: string[];
}

async function buildHarness(cwd: string[]): Promise<Harness> {
  const roots = await Promise.all(cwd.map((path) => realpath(path)));
  const workspaces = roots.map((path, index) => ({
    workspaceId: `ws_${index}`,
    displayName: `Fixture ${index}`,
    rootPath: path,
    createdAt: FIXED_NOW,
    policy: { perSessionQueueLimit: 20 },
  }));
  const config: AgentConfigV2 = {
    version: 2,
    desktopId: 'desktop_live',
    workspaces,
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: 'https://macbook-pro.tail0970fd.ts.net' },
  };
  const manager = new WorkspaceManager({
    configDir: cwd[0] ?? '/tmp',
    config,
    writeConfig: () => undefined,
  });
  const sessions = new SessionRegistry({ now: () => FIXED_NOW });
  const journal = new EventJournal();
  let runCounter = 0;
  const scheduler = new RunScheduler({
    sessions,
    workspaces: manager,
    journal,
    driver: new AgentSdkAdapter(),
    now: () => Date.now(),
    generateRunId: () => {
      runCounter += 1;
      return `run_live_${runCounter}`;
    },
  });
  const controller = new ManagedRunController({
    scheduler,
    sessions,
    normalizer: new EventNormalizer(journal),
  });
  return {
    controller,
    scheduler,
    sessions,
    journal,
    workspaceId: 'ws_0',
    roots: cwd,
  };
}

function journalText(journal: EventJournal, sessionId: string): string {
  return journal
    .recent(sessionId, 5_000)
    .filter((event) => event.type === 'message.delta')
    .map((event) => String((event.payload as Record<string, unknown>)['text'] ?? ''))
    .join('');
}

/** 等到 run 出现文本或已进入终态；避免 firstDelta 永不 resolve 时挂死。 */
async function waitForProgress(
  run: { summary(): { deltaCount: number; terminalAt: number | null } },
  label: string,
  timeoutMs = 180_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const summary = run.summary();
    if (summary.deltaCount > 0 || summary.terminalAt !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`run ${label} made no progress`);
}

describe('S02 real SDK regression', () => {
  it(
    'keeps two workspaces concurrently live with separate Claude sessions',
    async () => {
      const first = await createFixture('cross-a');
      const second = await createFixture('cross-b');
      const adapter = new AgentSdkAdapter();
      try {
        const runA = startLiveRun(adapter, {
          label: 'a',
          cwd: first,
          prompt: enumerationPrompt(CROSS_A),
          marker: CROSS_A,
        });
        const runB = startLiveRun(adapter, {
          label: 'b',
          cwd: second,
          prompt: enumerationPrompt(CROSS_B),
          marker: CROSS_B,
        });
        const [terminalA, terminalB] = await Promise.all([
          runA.terminal,
          runB.terminal,
        ]);

        expect(terminalA).toBe('succeeded');
        expect(terminalB).toBe('succeeded');
        expect(runA.summary().claudeSessionId).not.toBeNull();
        expect(runB.summary().claudeSessionId).not.toBeNull();
        expect(runA.summary().claudeSessionId).not.toBe(
          runB.summary().claudeSessionId,
        );
        expect(runA.summary().foreignEventCount).toBe(0);
        expect(runB.summary().foreignEventCount).toBe(0);
        await runA.close();
        await runB.close();
      } finally {
        await rm(first, { recursive: true, force: true });
        await rm(second, { recursive: true, force: true });
      }
    },
    600_000,
  );

  it(
    'queues a second prompt and resumes the same Claude session',
    async () => {
      const cwd = await createFixture('resume');
      const harness = await buildHarness([cwd]);
      try {
        const session = harness.sessions.create({
          workspaceId: harness.workspaceId,
        });
        const first = await harness.controller.sendPrompt(
          session.sessionId,
          [
            'Do not use any tools.',
            `Remember this exact marker: ${RESUME_MARKER}.`,
            'Reply with OK only.',
          ].join(' '),
          'cmd_live_1',
          'trace_live_1',
        );
        expect(first.status).toBe('starting');
        expect(
          await waitForTerminal(harness.sessions, session.sessionId, first.runId),
        ).toBe('succeeded');
        const claudeSessionId = harness.sessions.get(session.sessionId)
          .claudeSessionId;
        expect(claudeSessionId).not.toBeNull();

        const second = await harness.controller.sendPrompt(
          session.sessionId,
          'What exact marker did I ask you to remember? Reply with just the marker.',
          'cmd_live_2',
          'trace_live_2',
        );
        expect(
          await waitForTerminal(
            harness.sessions,
            session.sessionId,
            second.runId,
          ),
        ).toBe('succeeded');

        const runs = harness.sessions.get(session.sessionId).runsById;
        const firstRecord = runs.get(first.runId);
        const secondRecord = runs.get(second.runId);
        expect(secondRecord?.startedAt ?? 0).toBeGreaterThanOrEqual(
          firstRecord?.endedAt ?? Number.MAX_SAFE_INTEGER,
        );
        expect(journalText(harness.journal, session.sessionId)).toContain(
          RESUME_MARKER,
        );
        expect(harness.sessions.get(session.sessionId).claudeSessionId).toBe(
          claudeSessionId,
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    600_000,
  );

  it(
    'cancels one session without affecting the other',
    async () => {
      const first = await createFixture('cancel-a');
      const second = await createFixture('cancel-b');
      const adapter = new AgentSdkAdapter();
      try {
        const runA = startLiveRun(adapter, {
          label: 'cancel-a',
          cwd: first,
          prompt: longEnumerationPrompt(CROSS_A),
          marker: CROSS_A,
        });
        await waitForProgress(runA, 'a');
        const runB = startLiveRun(adapter, {
          label: 'cancel-b',
          cwd: second,
          prompt: enumerationPrompt(CROSS_B),
          marker: CROSS_B,
        });
        await waitForProgress(runB, 'b');
        expect(runA.summary().terminalAt).toBeNull();

        await runA.interrupt();
        expect(await runA.terminal).toBe('cancelled');
        expect(await runB.terminal).toBe('succeeded');
        expect(runB.summary().claudeSessionId).not.toBeNull();
        expect(runA.summary().foreignEventCount).toBe(0);
        expect(runB.summary().foreignEventCount).toBe(0);
        await runA.close();
        await runB.close();
      } finally {
        await rm(first, { recursive: true, force: true });
        await rm(second, { recursive: true, force: true });
      }
    },
    600_000,
  );

  it(
    'still denies Bash and never creates the target file',
    async () => {
      const cwd = await createFixture('deny');
      const forbidden = join(cwd, 'should-not-exist.txt');
      const harness = await buildHarness([cwd]);
      try {
        const session = harness.sessions.create({
          workspaceId: harness.workspaceId,
        });
        const accepted = await harness.controller.sendPrompt(
          session.sessionId,
          [
            'Use the Bash tool to run exactly this command:',
            `touch ${forbidden}`,
            'Then reply DONE.',
          ].join(' '),
          'cmd_live_deny',
          'trace_live_deny',
        );
        expect(
          await waitForTerminal(
            harness.sessions,
            session.sessionId,
            accepted.runId,
          ),
        ).toBe('succeeded');
        await expect(readFile(forbidden)).rejects.toThrow();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    600_000,
  );
});