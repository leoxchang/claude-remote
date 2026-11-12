import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentSdkAdapter } from '../../src/adapter/agent-sdk-adapter.js';
import { AdapterEvent } from '../../src/events/adapter-events.js';
import { denyAllPermissionGate } from '../permission-gate-fakes.js';

const TERMINAL_TIMEOUT_MS = 300_000;
const RESUME_MARKER = 'S01_RESUME_MARKER_71C4';

interface RunResult {
  claudeSessionId: string | null;
  text: string;
  deltaCount: number;
  status: string;
  toolStatuses: string[];
}

/** 起一次真实 run，收集文本与终态；不保存 prompt 正文。 */
async function runOnce(
  adapter: AgentSdkAdapter,
  options: {
    cwd: string;
    text: string;
    claudeSessionId: string | null;
    onFirstDelta?: () => Promise<void>;
  },
  onHandle?: (interrupt: () => Promise<void>) => void,
): Promise<RunResult> {
  let claudeSessionId: string | null = null;
  let text = '';
  let deltaCount = 0;
  let status = 'pending';
  let firstDelta = false;
  const toolStatuses: string[] = [];
  let resolveTerminal: () => void = () => undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  const handle = adapter.startRun({
    sessionId: 'session_01',
    workspaceId: 'live',
    adapterGeneration: 0,
    claudeSessionId: options.claudeSessionId,
    runId: `run_${Date.now()}`,
    text: options.text,
    cwd: options.cwd,
    deviceId: 'device_1',
    permissionBroker: denyAllPermissionGate(),
    onEvent: (event: AdapterEvent) => {
      if (event.kind === 'init') claudeSessionId = event.claudeSessionId;
      if (event.kind === 'textDelta') {
        text += event.text;
        deltaCount += 1;
        if (!firstDelta && options.onFirstDelta !== undefined) {
          firstDelta = true;
          void options.onFirstDelta();
        }
      }
      if (event.kind === 'toolCompleted') toolStatuses.push(event.status);
      if (event.kind === 'runResult') {
        status = event.status;
        resolveTerminal();
      }
    },
  });
  handle.resumeEvents();

  try {
    onHandle?.(() => handle.interrupt());
    await Promise.race([
      terminal,
      new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error('run did not reach a terminal state')),
          TERMINAL_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    await handle.close();
  }
  return { claudeSessionId, text, deltaCount, status, toolStatuses };
}

async function createFixture(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `s01-live-${label}-`));
}

describe('S01 real SDK smoke', () => {
  it('streams a run and resumes the same Claude session in a second run', async () => {
    const cwd = await createFixture('resume');
    const adapter = new AgentSdkAdapter();
    try {
      const first = await runOnce(adapter, {
        cwd,
        claudeSessionId: null,
        text: [
          'Do not use any tools.',
          `Remember this exact marker: ${RESUME_MARKER}.`,
          'Reply with OK only.',
        ].join(' '),
      });
      expect(first.status).toBe('succeeded');
      expect(first.deltaCount).toBeGreaterThan(0);
      expect(first.claudeSessionId).not.toBeNull();

      const second = await runOnce(adapter, {
        cwd,
        claudeSessionId: first.claudeSessionId,
        text: 'What exact marker did I ask you to remember? Reply with just the marker.',
      });
      expect(second.status).toBe('succeeded');
      expect(second.text).toContain(RESUME_MARKER);
      expect(second.claudeSessionId).toBe(first.claudeSessionId);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 600_000);

  it('cancels an active run through interrupt', async () => {
    const cwd = await createFixture('cancel');
    const adapter = new AgentSdkAdapter();
    let interrupt: (() => Promise<void>) | null = null;
    try {
      const result = await runOnce(
        adapter,
        {
          cwd,
          claudeSessionId: null,
          text: 'Do not use any tools. Count from 1 to 2000, one number per line.',
          onFirstDelta: async () => {
            await interrupt?.();
          },
        },
        (fn) => {
          interrupt = fn;
        },
      );
      expect(result.status).toBe('cancelled');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 600_000);

  it('denies a Bash tool call without executing it', async () => {
    const cwd = await createFixture('deny');
    const forbidden = join(cwd, 'should-not-exist.txt');
    const adapter = new AgentSdkAdapter();
    try {
      const result = await runOnce(adapter, {
        cwd,
        claudeSessionId: null,
        text: [
          'Use the Bash tool to run exactly this command:',
          `touch ${forbidden}`,
          'Then reply DONE.',
        ].join(' '),
      });
      expect(result.status).toBe('succeeded');
      await expect(readFile(forbidden)).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 600_000);
});