import { Options, SDKMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { setTimeout as delay } from 'node:timers/promises';

import { collectQuery } from '../collector.js';
import { createUserMessage } from './conversation.js';
import { ScenarioContext } from '../evidence.js';
import { createBaseOptions } from '../options.js';

const NORMAL_MARKER = 'S00_NORMAL_RESUME_51A0';
const INTERRUPT_MARKER = 'S00_INTERRUPT_MARKER_62BD';
const NONEXISTENT_SESSION_ID = '00000000-0000-0000-0000-000000000000';
const INTERRUPT_TIMEOUT_MS = 30_000;

const RECALL_PROMPT =
  'What exact marker did I ask you to remember? Reply with just the marker.';

/** 正常恢复、中断恢复和非法恢复的结果。 */
export interface RecoveryValidationResult {
  normalResumedMarker: boolean;
  interrupted: boolean;
  interruptOutcome: InterruptOutcome;
  interruptedResumedMarker: boolean;
  invalidResumeRejected: boolean;
  closed: boolean;
  normalSessionId: string;
  interruptedSessionId: string;
}

interface SingleTurnResult {
  sessionId: string;
  assistantText: string;
  resultSubtypes: string[];
  failed: boolean;
  closed: boolean;
}

/** 执行 SDK-09–12：正常 resume、interrupt、中断后 resume 和非法 resume。 */
export async function runRecoveryValidation(
  ctx: ScenarioContext,
): Promise<RecoveryValidationResult> {
  const observedAt = new Date().toISOString();

  const normalFirst = await runSingleTurn(
    ctx.fixtureRoot,
    `Remember this exact marker: ${NORMAL_MARKER}. Reply with OK only.`,
  );
  const normalResume = await runSingleTurn(ctx.fixtureRoot, RECALL_PROMPT, {
    resume: normalFirst.sessionId,
  });
  const normalResumedMarker = normalResume.assistantText.includes(NORMAL_MARKER);

  const interruptedTurn = await runInterruptedTurn(ctx.fixtureRoot);
  const interruptedResume = await runSingleTurn(ctx.fixtureRoot, RECALL_PROMPT, {
    resume: interruptedTurn.sessionId,
  });
  const interruptedResumedMarker = interruptedResume.assistantText.includes(
    INTERRUPT_MARKER,
  );

  const invalidResume = await attemptInvalidResume(ctx.fixtureRoot);
  const closed = normalResume.closed && interruptedTurn.closed && invalidResume.closed;

  await ctx.writeEvidence({
    id: 'SDK-09',
    status:
      interruptedTurn.interrupted && interruptedTurn.interruptOutcome !== 'timeout'
        ? 'PASS'
        : 'FAIL',
    summary: 'interrupt() stopped a streaming turn and the query closed',
    observedAt,
    data: {
      interrupted: interruptedTurn.interrupted,
      interruptOutcome: interruptedTurn.interruptOutcome,
      closed: interruptedTurn.closed,
      sessionId: interruptedTurn.sessionId,
    },
  });

  await ctx.writeEvidence({
    id: 'SDK-10',
    status: normalResumedMarker ? 'PASS' : 'FAIL',
    summary: 'A new query with resume read the marker from the finished session',
    observedAt,
    data: {
      normalSessionId: normalFirst.sessionId,
      resumedSessionId: normalResume.sessionId,
      sameSession: normalFirst.sessionId === normalResume.sessionId,
      markerRecovered: normalResumedMarker,
    },
  });

  await ctx.writeEvidence({
    id: 'SDK-11',
    status: interruptedResumedMarker ? 'PASS' : 'FAIL',
    summary: 'An explicit resume of the interrupted session recovered its context',
    observedAt,
    data: {
      interruptedSessionId: interruptedTurn.sessionId,
      resumedSessionId: interruptedResume.sessionId,
      markerRecovered: interruptedResumedMarker,
      resultSubtypes: interruptedResume.resultSubtypes,
    },
  });

  await ctx.writeEvidence({
    id: 'SDK-12',
    status: invalidResume.rejected ? 'PASS' : 'FAIL',
    summary: 'Resuming an unknown session id failed instead of creating a fake session',
    observedAt,
    data: invalidResume.detail,
  });

  return {
    normalResumedMarker,
    interrupted: interruptedTurn.interrupted,
    interruptOutcome: interruptedTurn.interruptOutcome,
    interruptedResumedMarker,
    invalidResumeRejected: invalidResume.rejected,
    closed,
    normalSessionId: normalFirst.sessionId,
    interruptedSessionId: interruptedTurn.sessionId,
  };
}

async function runSingleTurn(
  fixtureRoot: string,
  prompt: string,
  overrides: Partial<Options> = {},
): Promise<SingleTurnResult> {
  const q = query({
    prompt,
    options: createBaseOptions(fixtureRoot, overrides),
  });
  try {
    const collected = await collectQuery(q);
    return {
      sessionId: collected.sessionId ?? '',
      assistantText: collected.assistantText,
      resultSubtypes: collected.resultSubtypes,
      failed: collected.resultSubtypes.some((subtype) => subtype !== 'success'),
      closed: true,
    };
  } finally {
    q.close();
  }
}

type InterruptOutcome = 'receipt' | 'no_receipt' | 'timeout';

interface InterruptedTurnResult {
  sessionId: string;
  interrupted: boolean;
  interruptOutcome: InterruptOutcome;
  closed: boolean;
}

async function runInterruptedTurn(
  fixtureRoot: string,
): Promise<InterruptedTurnResult> {
  let sessionId = '';
  let interrupted = false;
  let interruptOutcome: InterruptOutcome = 'timeout';
  let closed = false;

  async function* openInput(): AsyncGenerator<SDKUserMessage> {
    yield createUserMessage(
      `Remember this exact marker: ${INTERRUPT_MARKER}. Then output the numbers 1 to 200, one number per line, and nothing else.`,
    );
    // 输入保持打开，由 close() 结束 query。
    await new Promise<void>(() => undefined);
  }

  const q = query({
    prompt: openInput(),
    options: createBaseOptions(fixtureRoot),
  });

  try {
    for await (const message of q) {
      if ('session_id' in message && typeof message.session_id === 'string') {
        sessionId = message.session_id;
      }
      if (isTextDelta(message) && !interrupted) {
        const outcome = await Promise.race([
          q
            .interrupt()
            .then((response): InterruptOutcome =>
              response === undefined ? 'no_receipt' : 'receipt',
            ),
          delay(INTERRUPT_TIMEOUT_MS).then((): InterruptOutcome => 'timeout'),
        ]);
        interruptOutcome = outcome;
        interrupted = outcome !== 'timeout';
        break;
      }
    }
  } finally {
    q.close();
    closed = true;
  }

  return { sessionId, interrupted, interruptOutcome, closed };
}

function isTextDelta(message: SDKMessage): boolean {
  if (message.type !== 'stream_event') return false;
  const event = message.event;
  if (event.type !== 'content_block_delta') return false;
  return event.delta.type === 'text_delta';
}

interface InvalidResumeAttempt {
  rejected: boolean;
  closed: boolean;
  detail: Record<string, unknown>;
}

async function attemptInvalidResume(
  fixtureRoot: string,
): Promise<InvalidResumeAttempt> {
  try {
    const result = await runSingleTurn(fixtureRoot, 'Reply with OK only.', {
      resume: NONEXISTENT_SESSION_ID,
    });
    const createdDifferentSession =
      result.sessionId.length > 0 && result.sessionId !== NONEXISTENT_SESSION_ID;
    return {
      rejected: result.failed && !createdDifferentSession,
      closed: true,
      detail: {
        threw: false,
        resultSubtypes: result.resultSubtypes,
        createdDifferentSession,
        sessionIdPresent: result.sessionId.length > 0,
      },
    };
  } catch (error: unknown) {
    return {
      rejected: true,
      closed: true,
      detail: {
        threw: true,
        errorName: error instanceof Error ? error.name : 'unknown',
      },
    };
  }
}