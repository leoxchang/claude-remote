import { rm } from 'node:fs/promises';

import { afterAll, describe, expect, it } from 'vitest';

import { AgentSdkAdapter } from '../../src/adapter/agent-sdk-adapter.js';
import {
  analyzeOverlap,
  createFixtureProject,
  startLiveRun,
  toEvidence,
  withTimeout,
} from './concurrency-harness.js';

const FIRST_DELTA_TIMEOUT_MS = 180_000;
const TERMINAL_TIMEOUT_MS = 300_000;
const POST_INTERRUPT_DELTA_TIMEOUT_MS = 120_000;

const MARKER_SAME_A = 'S02_CONC_SAME_A';
const MARKER_SAME_B = 'S02_CONC_SAME_B';
const MARKER_CROSS_A = 'S02_CONC_CROSS_A';
const MARKER_CROSS_B = 'S02_CONC_CROSS_B';
const MARKER_INTERRUPT_A = 'S02_CONC_INT_A';
const MARKER_INTERRUPT_B = 'S02_CONC_INT_B';

const fixtures: string[] = [];

afterAll(async () => {
  for (const fixture of fixtures) {
    await rm(fixture, { recursive: true, force: true });
  }
});

/** 枚举型长文本 prompt：文本流足够长，才能观测真实的并发窗口。 */
function promptFor(marker: string): string {
  return [
    'Do not use any tools. Do not read or write files.',
    'Output the integers from 1 to 400, one per line, in order.',
    'Do not explain anything.',
    `After the last integer, output exactly this line: ${marker}`,
  ].join(' ');
}

describe('CONC-01 real SDK concurrency gate', () => {
  it('keeps two different Claude sessions live in one workspace', async () => {
    const workspace = await createFixtureProject('same');
    fixtures.push(workspace);
    const adapter = new AgentSdkAdapter();
    const a = startLiveRun(adapter, {
      label: 'a',
      cwd: workspace,
      prompt: promptFor(MARKER_SAME_A),
      marker: MARKER_SAME_A,
    });
    const b = startLiveRun(adapter, {
      label: 'b',
      cwd: workspace,
      prompt: promptFor(MARKER_SAME_B),
      marker: MARKER_SAME_B,
    });

    try {
      await Promise.all([
        withTimeout(a.firstDelta, FIRST_DELTA_TIMEOUT_MS, 'a first delta'),
        withTimeout(b.firstDelta, FIRST_DELTA_TIMEOUT_MS, 'b first delta'),
      ]);
      const [statusA, statusB] = await Promise.all([
        withTimeout(a.terminal, TERMINAL_TIMEOUT_MS, 'a terminal'),
        withTimeout(b.terminal, TERMINAL_TIMEOUT_MS, 'b terminal'),
      ]);
      const report = analyzeOverlap(a.summary(), b.summary());
      console.info(
        JSON.stringify(toEvidence('same-workspace', [a, b], { overlap: report })),
      );

      expect(a.summary().claudeSessionId).not.toBe(b.summary().claudeSessionId);
      expect(report.overlapped).toBe(true);
      expect(report.textOverlapMs).toBeGreaterThan(1_000);
      expect(a.summary().sawMarker).toBe(true);
      expect(b.summary().sawMarker).toBe(true);
      expect(statusA).toBe('succeeded');
      expect(statusB).toBe('succeeded');
      expect(a.summary().foreignEventCount).toBe(0);
      expect(b.summary().foreignEventCount).toBe(0);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 600_000);

  it('keeps two sessions live across two workspaces', async () => {
    const workspaceA = await createFixtureProject('cross-a');
    const workspaceB = await createFixtureProject('cross-b');
    fixtures.push(workspaceA, workspaceB);
    const adapter = new AgentSdkAdapter();
    const a = startLiveRun(adapter, {
      label: 'a',
      cwd: workspaceA,
      prompt: promptFor(MARKER_CROSS_A),
      marker: MARKER_CROSS_A,
    });
    const b = startLiveRun(adapter, {
      label: 'b',
      cwd: workspaceB,
      prompt: promptFor(MARKER_CROSS_B),
      marker: MARKER_CROSS_B,
    });

    try {
      await Promise.all([
        withTimeout(a.firstDelta, FIRST_DELTA_TIMEOUT_MS, 'a first delta'),
        withTimeout(b.firstDelta, FIRST_DELTA_TIMEOUT_MS, 'b first delta'),
      ]);
      const [statusA, statusB] = await Promise.all([
        withTimeout(a.terminal, TERMINAL_TIMEOUT_MS, 'a terminal'),
        withTimeout(b.terminal, TERMINAL_TIMEOUT_MS, 'b terminal'),
      ]);
      const report = analyzeOverlap(a.summary(), b.summary());
      console.info(
        JSON.stringify(toEvidence('cross-workspace', [a, b], { overlap: report })),
      );

      expect(a.summary().claudeSessionId).not.toBe(b.summary().claudeSessionId);
      expect(report.overlapped).toBe(true);
      expect(report.textOverlapMs).toBeGreaterThan(1_000);
      expect(a.summary().sawMarker).toBe(true);
      expect(b.summary().sawMarker).toBe(true);
      expect(statusA).toBe('succeeded');
      expect(statusB).toBe('succeeded');
      expect(a.summary().foreignEventCount).toBe(0);
      expect(b.summary().foreignEventCount).toBe(0);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 600_000);

  it('interrupts one live run without stopping the other', async () => {
    const workspace = await createFixtureProject('interrupt');
    fixtures.push(workspace);
    const adapter = new AgentSdkAdapter();
    const a = startLiveRun(adapter, {
      label: 'a',
      cwd: workspace,
      prompt: promptFor(MARKER_INTERRUPT_A),
      marker: MARKER_INTERRUPT_A,
    });
    const b = startLiveRun(adapter, {
      label: 'b',
      cwd: workspace,
      prompt: promptFor(MARKER_INTERRUPT_B),
      marker: MARKER_INTERRUPT_B,
    });

    try {
      await Promise.all([
        withTimeout(a.firstDelta, FIRST_DELTA_TIMEOUT_MS, 'a first delta'),
        withTimeout(b.firstDelta, FIRST_DELTA_TIMEOUT_MS, 'b first delta'),
      ]);
      await a.interrupt();
      const statusA = await withTimeout(
        a.terminal,
        TERMINAL_TIMEOUT_MS,
        'a terminal',
      );
      const terminalAtA = a.summary().terminalAt ?? 0;
      const deltaAtB = await withTimeout(
        b.waitForDeltaAfter(terminalAtA),
        POST_INTERRUPT_DELTA_TIMEOUT_MS,
        'b delta after a terminal',
      );
      const report = analyzeOverlap(a.summary(), b.summary());
      console.info(
        JSON.stringify(
          toEvidence('independent-interrupt', [a, b], {
            overlap: report,
            interruptedRunTerminalAt: terminalAtA,
            otherRunDeltaAfterInterruptAt: deltaAtB,
          }),
        ),
      );

      expect(['cancelled', 'interrupted']).toContain(statusA);
      expect(deltaAtB).toBeGreaterThan(terminalAtA);
      expect(report.overlapped).toBe(true);
      expect(a.summary().foreignEventCount).toBe(0);
      expect(b.summary().foreignEventCount).toBe(0);

      await b.interrupt();
      const statusB = await withTimeout(
        b.terminal,
        TERMINAL_TIMEOUT_MS,
        'b terminal',
      );
      expect(statusB).not.toBe('failed');
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 600_000);
});