import { SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';

import { collectQuery } from '../collector.js';
import { ScenarioContext } from '../evidence.js';
import { createBaseOptions } from '../options.js';

const STREAM_MARKER = 'S00_STREAM_MARKER_91C2';

const FIRST_TURN_PROMPT = [
  `Remember this exact marker for the next turn: ${STREAM_MARKER}.`,
  'Reply with OK only.',
].join(' ');

const SECOND_TURN_PROMPT =
  'What exact marker did I ask you to remember? Reply with just the marker.';

/** 构造一条 Streaming Input 用户消息。 */
export function createUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

/** 同一个 query 内两轮的流式输入结果。 */
export interface TwoTurnConversationResult {
  sessionId: string;
  turnResults: number;
  secondTurnText: string;
  deltaCount: number;
  sawAssistant: boolean;
}

/** 用一个 query 送两轮输入：第一轮结果到达后才 yield 第二轮。 */
export async function runTwoTurnConversation(
  ctx: ScenarioContext,
): Promise<TwoTurnConversationResult> {
  let completeFirstTurn: (() => void) | undefined;
  const firstTurnDone = new Promise<void>((resolve) => {
    completeFirstTurn = resolve;
  });
  let resultCount = 0;
  let firstTurnFinished = false;
  const secondTurnChunks: string[] = [];

  async function* streamedInput(): AsyncGenerator<SDKUserMessage> {
    yield createUserMessage(FIRST_TURN_PROMPT);
    await firstTurnDone;
    yield createUserMessage(SECOND_TURN_PROMPT);
  }

  const q = query({
    prompt: streamedInput(),
    options: createBaseOptions(ctx.fixtureRoot),
  });

  try {
    const collected = await collectQuery(q, (message) => {
      if (message.type === 'result') {
        resultCount += 1;
        firstTurnFinished = true;
        completeFirstTurn?.();
      }
      if (message.type === 'assistant' && firstTurnFinished) {
        for (const block of message.message.content) {
          if (block.type === 'text') secondTurnChunks.push(block.text);
        }
      }
    });

    const observedAt = new Date().toISOString();
    const secondTurnText = secondTurnChunks.join('');
    const sawAssistant = collected.messageTypes.includes('assistant');

    await ctx.writeEvidence({
      id: 'SDK-05',
      status: secondTurnText.includes(STREAM_MARKER) && resultCount === 2 ? 'PASS' : 'FAIL',
      summary: 'One query accepted two streamed user turns and reused the first turn context',
      observedAt,
      data: {
        sessionId: collected.sessionId,
        turnResults: resultCount,
        markerRecovered: secondTurnText.includes(STREAM_MARKER),
      },
    });

    await ctx.writeEvidence({
      id: 'SDK-06',
      status:
        collected.textDeltas.length > 0 && sawAssistant ? 'PASS' : 'FAIL',
      summary: 'Assistant messages and stream_event text deltas were both observed',
      observedAt,
      data: {
        messageTypeCounts: countByType(collected.messageTypes),
        messageTypeSequence: collected.messageTypes,
        deltaCount: collected.textDeltas.length,
        sawAssistant,
        resultSubtypes: collected.resultSubtypes,
      },
    });

    return {
      sessionId: collected.sessionId ?? '',
      turnResults: resultCount,
      secondTurnText,
      deltaCount: collected.textDeltas.length,
      sawAssistant,
    };
  } finally {
    q.close();
  }
}

function countByType(types: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of types) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}