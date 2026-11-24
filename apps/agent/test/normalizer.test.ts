import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdapterEvent } from '../src/events/adapter-events.js';
import { EventJournal } from '../src/events/journal.js';
import { EventNormalizer } from '../src/events/normalizer.js';

const SESSION = 'session_01';
const RUN = 'run_01';

const textDelta = (index: number, text: string): AdapterEvent => ({
  kind: 'textDelta',
  sessionId: SESSION,
  runId: RUN,
  assistantMessageId: 'msg_1',
  contentBlockIndex: index,
  text,
});

const thinkingDelta = (index: number, text: string): AdapterEvent => ({
  kind: 'thinkingDelta',
  sessionId: SESSION,
  runId: RUN,
  assistantMessageId: 'msg_1',
  contentBlockIndex: index,
  text,
});

const completed = (text: string): AdapterEvent => ({
  kind: 'assistantCompleted',
  sessionId: SESSION,
  runId: RUN,
  assistantMessageId: 'msg_1',
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
});

function setup(): { journal: EventJournal; normalizer: EventNormalizer } {
  const journal = new EventJournal();
  const normalizer = new EventNormalizer(journal);
  return { journal, normalizer };
}

function payloadOf(journal: EventJournal, type: string): Record<string, unknown>[] {
  return journal
    .recent(SESSION, 100)
    .filter((event) => event.type === type)
    .map((event) => event.payload as Record<string, unknown>);
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('EventNormalizer thinking', () => {
  it('keeps thinking deltas separate from assistant text', () => {
    vi.useFakeTimers();
    const { journal, normalizer } = setup();

    normalizer.consume(thinkingDelta(0, '先看看目录'));
    normalizer.consume(textDelta(1, '目录里有三个文件'));

    const thinking = payloadOf(journal, 'thinking.delta');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({
      assistantMessageId: 'msg_1',
      text: '先看看目录',
    });

    vi.advanceTimersByTime(50);

    expect(payloadOf(journal, 'message.delta')[0]).toMatchObject({
      text: '目录里有三个文件',
    });
  });

  it('writes the completed thinking block once', () => {
    const { journal, normalizer } = setup();

    normalizer.consume({
      kind: 'thinkingCompleted',
      sessionId: SESSION,
      runId: RUN,
      assistantMessageId: 'msg_1',
      content: [{ type: 'thinking', text: '完整思考' }],
    });

    const completedThinking = payloadOf(journal, 'thinking.completed');
    expect(completedThinking).toHaveLength(1);
    expect(completedThinking[0]).toMatchObject({
      assistantMessageId: 'msg_1',
      text: '完整思考',
      contentTruncated: false,
    });
  });
});

describe('EventNormalizer deltas', () => {
  it('coalesces adjacent deltas and flushes after 50 ms', () => {
    vi.useFakeTimers();
    const { journal, normalizer } = setup();

    normalizer.consume(textDelta(0, '你好'));
    normalizer.consume(textDelta(0, '世界'));

    expect(payloadOf(journal, 'message.delta')).toHaveLength(0);

    vi.advanceTimersByTime(50);

    const deltas = payloadOf(journal, 'message.delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      assistantMessageId: 'msg_1',
      text: '你好世界',
      index: 0,
    });
  });

  it('flushes early once 16 KiB of text accumulated', () => {
    const { journal, normalizer } = setup();

    normalizer.consume(textDelta(0, 'a'.repeat(16 * 1024)));

    expect(payloadOf(journal, 'message.delta')).toHaveLength(1);
  });

  it('flushes the previous block when the content block changes', () => {
    vi.useFakeTimers();
    const { journal, normalizer } = setup();

    normalizer.consume(textDelta(0, 'first'));
    normalizer.consume(textDelta(1, 'second'));

    const deltas = payloadOf(journal, 'message.delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ text: 'first', index: 0 });
  });
});

describe('EventNormalizer completed messages', () => {
  it('carries the full content when it fits in 32 KiB', () => {
    const { journal, normalizer } = setup();

    normalizer.consume(completed('短回复'));

    const [message] = payloadOf(journal, 'message.completed');
    expect(message).toMatchObject({
      assistantMessageId: 'msg_1',
      text: '短回复',
      content: [{ type: 'text', text: '短回复' }],
      contentTruncated: false,
      stopReason: 'end_turn',
    });
  });

  it('drops the content and marks it truncated above 32 KiB', () => {
    const { journal, normalizer } = setup();

    normalizer.consume(completed('a'.repeat(32 * 1024 + 1)));

    const [message] = payloadOf(journal, 'message.completed');
    expect(message).toMatchObject({ content: [], contentTruncated: true });
  });
});

describe('EventNormalizer tools', () => {
  it('truncates tool input above 16 KiB', () => {
    const { journal, normalizer } = setup();

    normalizer.consume({
      kind: 'toolStarted',
      sessionId: SESSION,
      runId: RUN,
      toolUseId: 'toolu_1',
      toolName: 'Read',
      input: { path: 'a'.repeat(17 * 1024) },
    });

    const [started] = payloadOf(journal, 'tool.started');
    expect(started).toMatchObject({ toolUseId: 'toolu_1', input: {}, inputTruncated: true });
  });

  it('keeps small tool input intact', () => {
    const { journal, normalizer } = setup();

    normalizer.consume({
      kind: 'toolStarted',
      sessionId: SESSION,
      runId: RUN,
      toolUseId: 'toolu_1',
      toolName: 'Read',
      input: { path: 'src/example.ts' },
    });

    const [started] = payloadOf(journal, 'tool.started');
    expect(started).toMatchObject({
      input: { path: 'src/example.ts' },
      inputTruncated: false,
    });
  });

  it('splits tool output into utf-8 safe 32 KiB chunks', () => {
    const { journal, normalizer } = setup();
    const text = '中'.repeat(12_000);

    normalizer.consume({
      kind: 'toolOutput',
      sessionId: SESSION,
      runId: RUN,
      toolUseId: 'toolu_1',
      text,
    });

    const outputs = payloadOf(journal, 'tool.output');
    expect(outputs).toHaveLength(1);
    const chunk = outputs[0]?.['chunk'] as string;
    expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(chunk).not.toContain('�');
    expect(outputs[0]).toMatchObject({ truncated: true });
  });

  it('truncates the completed summary to 4 KiB', () => {
    const { journal, normalizer } = setup();

    normalizer.consume({
      kind: 'toolCompleted',
      sessionId: SESSION,
      runId: RUN,
      toolUseId: 'toolu_1',
      status: 'succeeded',
      isError: false,
      summary: 'x'.repeat(5 * 1024),
    });

    const [done] = payloadOf(journal, 'tool.completed');
    expect(Buffer.byteLength(String(done?.['summary']), 'utf8')).toBeLessThanOrEqual(
      4 * 1024,
    );
  });
});

describe('EventNormalizer lifecycle', () => {
  it('emits session.status on init with the claude session id', () => {
    const { journal, normalizer } = setup();

    normalizer.consume({
      kind: 'init',
      sessionId: SESSION,
      runId: RUN,
      claudeSessionId: 'claude_01',
    });

    const [status] = payloadOf(journal, 'session.status');
    expect(status).toMatchObject({
      state: 'running',
      claudeSessionId: 'claude_01',
      activeRunId: RUN,
    });
  });

  it('emits run.completed with the final status', () => {
    const { journal, normalizer } = setup();

    normalizer.consume({
      kind: 'runResult',
      sessionId: SESSION,
      runId: RUN,
      status: 'cancelled',
    });

    const [run] = payloadOf(journal, 'run.completed');
    expect(run).toMatchObject({ status: 'cancelled' });
  });

  it('adds a denied tool completion when a permission was denied after start', () => {
    const { journal, normalizer } = setup();
    normalizer.consume({
      kind: 'toolStarted',
      sessionId: SESSION,
      runId: RUN,
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      input: {},
    });

    normalizer.consume({
      kind: 'permissionDenied',
      sessionId: SESSION,
      runId: RUN,
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      outcome: 'denied',
    });

    const completions = payloadOf(journal, 'tool.completed');
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ toolUseId: 'toolu_1', status: 'denied' });
  });
});
describe('EventNormalizer extra branches', () => {
  it('numbers tool output chunks per tool', () => {
    const { journal, normalizer } = setup();
    const output = (text: string): AdapterEvent => ({
      kind: 'toolOutput',
      sessionId: SESSION,
      runId: RUN,
      toolUseId: 'toolu_1',
      text,
    });

    normalizer.consume(output('a'));
    normalizer.consume(output('b'));

    expect(
      payloadOf(journal, 'tool.output').map((payload) => payload['chunkSeq']),
    ).toEqual([1, 2]);
  });

  it('includes an error summary when a run fails', () => {
    const { journal, normalizer } = setup();

    normalizer.consume({
      kind: 'runResult',
      sessionId: SESSION,
      runId: RUN,
      status: 'failed',
      errorSummary: 'sdk reported an error',
    });

    const [run] = payloadOf(journal, 'run.completed');
    expect(run).toMatchObject({
      status: 'failed',
      errorSummary: 'sdk reported an error',
    });
  });
});
