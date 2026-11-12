import { describe, expect, it } from 'vitest';

import { AdapterEvent } from '../src/events/adapter-events.js';
import { EventJournal } from '../src/events/journal.js';
import { EventNormalizer } from '../src/events/normalizer.js';

const SESSION = 'session_01';
const RUN = 'run_01';

function setup(): { journal: EventJournal; normalizer: EventNormalizer } {
  const journal = new EventJournal();
  return { journal, normalizer: new EventNormalizer(journal) };
}

function toolStarted(runId: string, toolUseId: string): AdapterEvent {
  return {
    kind: 'toolStarted',
    sessionId: SESSION,
    runId,
    toolUseId,
    toolName: 'Bash',
    input: {},
  };
}

function toolCompleted(
  runId: string,
  toolUseId: string,
  status: 'succeeded' | 'failed',
): AdapterEvent {
  return {
    kind: 'toolCompleted',
    sessionId: SESSION,
    runId,
    toolUseId,
    status,
    isError: status === 'failed',
    summary: 'late sdk result',
  };
}

function permissionDenied(
  runId: string,
  toolUseId: string | undefined,
  outcome: 'denied' | 'cancelled',
): AdapterEvent {
  return {
    kind: 'permissionDenied',
    sessionId: SESSION,
    runId,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    toolName: 'Bash',
    outcome,
  };
}

function completions(journal: EventJournal): Record<string, unknown>[] {
  return journal
    .recent(SESSION, 100)
    .filter((event) => event.type === 'tool.completed')
    .map((event) => event.payload as Record<string, unknown>);
}

function eventsFor(
  journal: EventJournal,
  toolUseId: string,
): Record<string, unknown>[] {
  return journal
    .recent(SESSION, 100)
    .filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload['toolUseId'] === toolUseId;
    })
    .map((event) => event.payload as Record<string, unknown>);
}

describe('EventNormalizer S03 managed denials', () => {
  it('handles tool.started before and after a managed denial without duplicate completion', () => {
    const { journal, normalizer } = setup();
    normalizer.consume(toolStarted(RUN, 'toolu_1'));
    normalizer.consume(permissionDenied(RUN, 'toolu_1', 'denied'));
    normalizer.consume(toolCompleted(RUN, 'toolu_1', 'failed'));

    expect(completions(journal)).toHaveLength(1);
    expect(completions(journal)[0]).toMatchObject({
      toolUseId: 'toolu_1',
      status: 'denied',
      isError: true,
    });

    normalizer.consume(permissionDenied(RUN, 'toolu_2', 'denied'));
    expect(eventsFor(journal, 'toolu_2')).toHaveLength(0);
    normalizer.consume(toolStarted(RUN, 'toolu_2'));
    expect(
      eventsFor(journal, 'toolu_2').filter(
        (payload) => payload['status'] === 'denied',
      ),
    ).toHaveLength(1);
    normalizer.consume(toolCompleted(RUN, 'toolu_2', 'failed'));
    expect(
      eventsFor(journal, 'toolu_2').filter(
        (payload) => payload['status'] === 'denied',
      ),
    ).toHaveLength(1);
  });

  it('maps cancelled outcomes to cancelled completions', () => {
    const { journal, normalizer } = setup();
    normalizer.consume(toolStarted(RUN, 'toolu_3'));
    normalizer.consume(permissionDenied(RUN, 'toolu_3', 'cancelled'));

    expect(completions(journal)).toEqual([
      expect.objectContaining({ toolUseId: 'toolu_3', status: 'cancelled' }),
    ]);
  });

  it('keeps denial state isolated per run for the same toolUseID', () => {
    const { journal, normalizer } = setup();
    normalizer.consume(toolStarted(RUN, 'toolu_4'));
    normalizer.consume(permissionDenied('run_02', 'toolu_4', 'denied'));

    expect(completions(journal)).toHaveLength(0);

    normalizer.consume(toolCompleted(RUN, 'toolu_4', 'succeeded'));
    expect(completions(journal)).toEqual([
      expect.objectContaining({ toolUseId: 'toolu_4', status: 'succeeded' }),
    ]);
  });

  it('deduplicates repeated SDK completions', () => {
    const { journal, normalizer } = setup();
    normalizer.consume(toolStarted(RUN, 'toolu_5'));
    normalizer.consume(toolCompleted(RUN, 'toolu_5', 'succeeded'));
    normalizer.consume(toolCompleted(RUN, 'toolu_5', 'failed'));

    expect(completions(journal)).toHaveLength(1);
    expect(completions(journal)[0]?.['status']).toBe('succeeded');
  });

  it('drops short-lived denial state when a run closes', () => {
    const { journal, normalizer } = setup();
    normalizer.consume(permissionDenied(RUN, 'toolu_6', 'denied'));

    normalizer.clearRun(RUN);
    normalizer.consume(toolStarted(RUN, 'toolu_6'));

    expect(
      eventsFor(journal, 'toolu_6').filter(
        (payload) => payload['status'] === 'denied',
      ),
    ).toHaveLength(0);
  });
});