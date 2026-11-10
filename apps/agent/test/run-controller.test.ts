import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockDriver } from '../src/adapter/mock-driver.js';
import { AdapterEvent } from '../src/events/adapter-events.js';
import { EventJournal } from '../src/events/journal.js';
import { EventNormalizer } from '../src/events/normalizer.js';
import { RunController } from '../src/run/run-controller.js';
import { SessionController } from '../src/session/session-controller.js';

interface Harness {
  sessions: SessionController;
  journal: EventJournal;
  driver: MockDriver;
  controller: RunController;
  sessionId: string;
}

async function setup(): Promise<Harness> {
  const sessions = new SessionController();
  const journal = new EventJournal();
  const normalizer = new EventNormalizer(journal);
  const driver = new MockDriver();
  const controller = new RunController({
    sessions,
    driver,
    journal,
    normalizer,
    cwd: '/tmp/s01-fixture',
  });
  const session = await sessions.start('default');
  return { sessions, journal, driver, controller, sessionId: session.sessionId };
}

const init = (sessionId: string, runId: string): AdapterEvent => ({
  kind: 'init',
  sessionId,
  runId,
  claudeSessionId: 'claude_01',
});

const delta = (sessionId: string, runId: string): AdapterEvent => ({
  kind: 'textDelta',
  sessionId,
  runId,
  assistantMessageId: 'msg_1',
  contentBlockIndex: 0,
  text: 'hello',
});

const types = (journal: EventJournal, sessionId: string): string[] =>
  journal.recent(sessionId, 100).map((event) => event.type);

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('RunController lifecycle', () => {
  it('accepts a prompt and records the run timeline', async () => {
    const { controller, driver, journal, sessions, sessionId } = await setup();

    const accepted = await controller.sendPrompt(sessionId, 'hello', 'cmd_1');
    driver.emit(init(sessionId, accepted.runId));
    driver.emit(delta(sessionId, accepted.runId));
    driver.finish('succeeded');

    expect(accepted).toMatchObject({
      sessionId,
      runId: expect.stringMatching(/^run_/),
      status: 'starting',
    });
    expect(types(journal, sessionId)).toEqual([
      'session.status',
      'message.delta',
      'run.completed',
    ]);
    expect(controller.activeRun(sessionId)).toBeNull();
    expect(sessions.get(sessionId).claudeSessionId).toBe('claude_01');
  });

  it('rejects a second prompt while a run is active', async () => {
    const { controller, sessionId } = await setup();
    await controller.sendPrompt(sessionId, 'first', 'cmd_1');

    await expect(
      controller.sendPrompt(sessionId, 'second', 'cmd_2'),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
  });

  it('rejects a prompt for an unknown session', async () => {
    const { controller } = await setup();

    await expect(
      controller.sendPrompt('session_missing', 'hello', 'cmd_1'),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('marks a failed run', async () => {
    const { controller, driver, journal, sessionId } = await setup();
    const accepted = await controller.sendPrompt(sessionId, 'hello', 'cmd_1');

    driver.finish('failed');

    expect(accepted.runId).toMatch(/^run_/);
    const [completed] = journal
      .recent(sessionId, 100)
      .filter((event) => event.type === 'run.completed');
    expect(completed?.payload).toMatchObject({ status: 'failed' });
  });

  it('resumes the same claude session on the second run', async () => {
    const { controller, driver, sessionId } = await setup();
    const first = await controller.sendPrompt(sessionId, 'one', 'cmd_1');
    driver.emit(init(sessionId, first.runId));
    driver.finish('succeeded');

    await controller.sendPrompt(sessionId, 'two', 'cmd_2');

    expect(driver.runs).toHaveLength(2);
    expect(driver.runs[0]?.claudeSessionId).toBeNull();
    expect(driver.runs[1]?.claudeSessionId).toBe('claude_01');
  });
});

describe('RunController cancellation', () => {
  it('rejects a cancel for a run that is not active', async () => {
    const { controller, sessionId } = await setup();

    await expect(
      controller.cancel(sessionId, 'run_missing'),
    ).rejects.toMatchObject({ code: 'RUN_NOT_ACTIVE' });
  });

  it('moves to cancelling and finishes on the driver terminal event', async () => {
    const { controller, driver, journal, sessionId } = await setup();
    const accepted = await controller.sendPrompt(sessionId, 'hello', 'cmd_1');
    driver.script.interruptBehavior = 'emit-cancelled';

    const cancelled = await controller.cancel(sessionId, accepted.runId);

    expect(cancelled.status).toBe('cancelling');
    expect(controller.activeRun(sessionId)).toBeNull();
    const [completed] = journal
      .recent(sessionId, 100)
      .filter((event) => event.type === 'run.completed');
    expect(completed?.payload).toMatchObject({ status: 'cancelled' });
  });

  it('forces an interrupted run after ten seconds without a terminal event', async () => {
    vi.useFakeTimers();
    const { controller, driver, journal, sessionId } = await setup();
    const accepted = await controller.sendPrompt(sessionId, 'hello', 'cmd_1');
    driver.script.interruptBehavior = 'silent';

    await controller.cancel(sessionId, accepted.runId);
    vi.advanceTimersByTime(10_000);

    expect(controller.activeRun(sessionId)).toBeNull();
    expect(driver.closedHandles).toBe(1);
    const [completed] = journal
      .recent(sessionId, 100)
      .filter((event) => event.type === 'run.completed');
    expect(completed?.payload).toMatchObject({ status: 'interrupted' });
  });
});

describe('RunController permission denied', () => {
  it('records the denial and lets the run succeed', async () => {
    const { controller, driver, journal, sessionId } = await setup();
    const accepted = await controller.sendPrompt(sessionId, 'run bash', 'cmd_1');

    driver.emit({
      kind: 'toolStarted',
      sessionId,
      runId: accepted.runId,
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      input: { command: 'printf hi' },
    });
    driver.emit({
      kind: 'permissionDenied',
      sessionId,
      runId: accepted.runId,
      toolUseId: 'toolu_1',
      toolName: 'Bash',
    });
    driver.finish('succeeded');

    const events = journal.recent(sessionId, 100);
    expect(events.map((event) => event.type)).toContain('tool.completed');
    expect(
      events.find((event) => event.type === 'tool.completed')?.payload,
    ).toMatchObject({ status: 'denied' });
    expect(types(journal, sessionId).at(-1)).toBe('run.completed');
  });
});