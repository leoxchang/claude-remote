import { EventMessage } from '@claude-remote/protocol/types';

/** SDK 中立事件；只有 Adapter 产生，其他模块不感知 SDK 类型。 */
export type AdapterEvent =
  | { kind: 'init'; sessionId: string; runId: string; claudeSessionId: string }
  | {
      kind: 'textDelta';
      sessionId: string;
      runId: string;
      assistantMessageId: string;
      contentBlockIndex: number;
      text: string;
    }
  | {
      kind: 'thinkingDelta';
      sessionId: string;
      runId: string;
      assistantMessageId: string;
      contentBlockIndex: number;
      text: string;
    }
  | {
      kind: 'thinkingCompleted';
      sessionId: string;
      runId: string;
      assistantMessageId: string;
      content: Array<{ type: 'thinking'; text: string }>;
    }
  | {
      kind: 'assistantCompleted';
      sessionId: string;
      runId: string;
      assistantMessageId: string;
      content: Array<{ type: 'text'; text: string }>;
      stopReason?: string;
    }
  | {
      kind: 'toolStarted';
      sessionId: string;
      runId: string;
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      kind: 'toolOutput';
      sessionId: string;
      runId: string;
      toolUseId: string;
      text: string;
    }
  | {
      kind: 'toolCompleted';
      sessionId: string;
      runId: string;
      toolUseId: string;
      status: 'succeeded' | 'failed' | 'denied' | 'cancelled';
      isError: boolean;
      summary: string;
    }
  | {
      kind: 'permissionDenied';
      sessionId: string;
      runId: string;
      toolUseId?: string;
      toolName: string;
      outcome: 'denied' | 'cancelled';
    }
  | {
      kind: 'runResult';
      sessionId: string;
      runId: string;
      status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
      claudeSessionId?: string;
      errorSummary?: string;
    };

/** Journal 中带 eventId/seq 的时间线事件。 */
export type TimelineEvent = EventMessage;