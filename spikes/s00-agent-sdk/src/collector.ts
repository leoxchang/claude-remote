import { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Query } from '@anthropic-ai/claude-agent-sdk';

/** 一次 query 的内存摘要，不写盘；完整消息只保留在内存里。 */
export interface CollectedSession {
  sessionId?: string;
  messageTypes: string[];
  assistantText: string;
  textDeltas: string[];
  resultSubtypes: string[];
  messages: SDKMessage[];
}

/** 消费一个 Query，收集消息类型、助手文本和 text_delta 增量。 */
export async function collectQuery(
  q: Query,
  onMessage?: (message: SDKMessage) => void,
): Promise<CollectedSession> {
  const messages: SDKMessage[] = [];
  const messageTypes: string[] = [];
  const textDeltas: string[] = [];
  const resultSubtypes: string[] = [];
  const assistantChunks: string[] = [];
  let sessionId: string | undefined;

  for await (const message of q) {
    messages.push(message);
    messageTypes.push(message.type);
    onMessage?.(message);

    if ('session_id' in message && typeof message.session_id === 'string') {
      sessionId ??= message.session_id;
    }

    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') assistantChunks.push(block.text);
      }
    }

    if (message.type === 'stream_event') {
      const event = message.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        textDeltas.push(event.delta.text);
      }
    }

    if (message.type === 'result') resultSubtypes.push(message.subtype);
  }

  return {
    sessionId,
    messageTypes,
    assistantText: assistantChunks.join(''),
    textDeltas,
    resultSubtypes,
    messages,
  };
}