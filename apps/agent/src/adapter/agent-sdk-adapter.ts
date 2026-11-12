import {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  query,
} from '@anthropic-ai/claude-agent-sdk';

import { AdapterEvent } from '../events/adapter-events.js';
import {
  ManagedRunDriver,
  ManagedRunHandle,
  ManagedRunStart,
} from './managed-run-driver.js';

/** S00 验证过的完整设置来源。 */
const SETTING_SOURCES = ['user', 'project', 'local'] as const;

/** S01 没有手机审批；需要人工决策的工具一律拒绝。 */
const DENIAL_MESSAGE = 'Mobile approval is not available in S01';

/**
 * 用户设置里的 allow 规则会让工具跳过 canUseTool，
 * 因此再用 PreToolUse hook 在工具执行前强制拒绝。
 */
async function denyBeforeToolUse(): Promise<{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENIAL_MESSAGE,
    },
  };
}

/** 注入 SDK 的 query 工厂，便于测试。 */
export interface QueryFactoryParams {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}

export type QueryFactory = (params: QueryFactoryParams) => Query;

interface RunState {
  messageId: string | null;
  interrupted: boolean;
  terminal: boolean;
  closed: boolean;
}

/** 真实 Agent SDK 适配器；SDK 类型只出现在本文件。 */
export class AgentSdkAdapter implements ManagedRunDriver {
  private readonly queryFactory: QueryFactory;

  constructor(options: { queryFactory?: QueryFactory } = {}) {
    this.queryFactory =
      options.queryFactory ?? ((params) => query(params));
  }

  /**
   * 每次 run 启动一个新的 query，只包含当前 prompt。
   *
   * 方法同步返回句柄：query 与 Streaming Input 在当前调用栈创建，
   * SDK 事件在 resumeEvents 之前先缓冲。
   */
  startRun(input: ManagedRunStart): ManagedRunHandle {
    const options: Options = {
      cwd: input.cwd,
      permissionMode: 'default',
      persistSession: true,
      includePartialMessages: true,
      settingSources: [...SETTING_SOURCES],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      canUseTool: async () => ({
        behavior: 'deny',
        message: DENIAL_MESSAGE,
        interrupt: false,
      }),
      hooks: {
        PreToolUse: [{ hooks: [denyBeforeToolUse] }],
      },
      ...(input.claudeSessionId === null
        ? {}
        : { resume: input.claudeSessionId }),
    };
    const q = this.queryFactory({ prompt: singleMessage(input.text), options });
    const state: RunState = {
      messageId: null,
      interrupted: false,
      terminal: false,
      closed: false,
    };
    const pending: AdapterEvent[] = [];
    let resumed = false;
    const emit = (event: AdapterEvent): void => {
      if (resumed) {
        input.onEvent(event);
        return;
      }
      pending.push(event);
    };
    void this.consume(q, input, state, emit);

    return {
      interrupt: async () => {
        state.interrupted = true;
        await q.interrupt();
      },
      close: async () => {
        if (state.closed) return;
        state.closed = true;
        q.close();
      },
      resumeEvents: () => {
        if (resumed) return;
        resumed = true;
        for (const event of pending.splice(0)) input.onEvent(event);
      },
    };
  }

  private async consume(
    q: Query,
    input: ManagedRunStart,
    state: RunState,
    emit: (event: AdapterEvent) => void,
  ): Promise<void> {
    try {
      for await (const message of q) {
        this.mapMessage(message, input, state, emit);
      }
    } catch {
      if (!state.terminal) {
        emit({
          kind: 'runResult',
          sessionId: input.sessionId,
          runId: input.runId,
          status: state.interrupted ? 'cancelled' : 'failed',
          ...(state.interrupted ? {} : { errorSummary: 'sdk reported an error' }),
        });
        state.terminal = true;
      }
    } finally {
      if (!state.closed) {
        state.closed = true;
        q.close();
      }
    }
  }

  private mapMessage(
    message: SDKMessage,
    input: ManagedRunStart,
    state: RunState,
    emit: (event: AdapterEvent) => void,
  ): void {
    if (message.type === 'system' && message.subtype === 'init') {
      emit({
        kind: 'init',
        sessionId: input.sessionId,
        runId: input.runId,
        claudeSessionId: message.session_id,
      });
      return;
    }

    if (message.type === 'stream_event') {
      this.mapStreamEvent(message.event, input, state, emit);
      return;
    }

    if (message.type === 'assistant') {
      this.mapAssistant(message.message.id, message.message.content, input, emit);
      return;
    }

    if (message.type === 'user') {
      this.mapToolResults(message.message.content, input, emit);
      return;
    }

    if (message.type === 'result') {
      if (state.terminal) return;
      state.terminal = true;
      emit({
        kind: 'runResult',
        sessionId: input.sessionId,
        runId: input.runId,
        status:
          message.subtype === 'success'
            ? 'succeeded'
            : state.interrupted
              ? 'cancelled'
              : 'failed',
        ...(message.subtype === 'success' || state.interrupted
          ? {}
          : { errorSummary: 'run failed' }),
      });
    }
  }

  private mapStreamEvent(
    event: Extract<SDKMessage, { type: 'stream_event' }>['event'],
    input: ManagedRunStart,
    state: RunState,
    emit: (event: AdapterEvent) => void,
  ): void {
    if (event.type === 'message_start') {
      state.messageId = event.message.id;
      return;
    }
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      emit({
        kind: 'textDelta',
        sessionId: input.sessionId,
        runId: input.runId,
        assistantMessageId: state.messageId ?? 'msg_unknown',
        contentBlockIndex: event.index,
        text: event.delta.text,
      });
    }
  }

  private mapAssistant(
    messageId: string,
    content: readonly unknown[],
    input: ManagedRunStart,
    emit: (event: AdapterEvent) => void,
  ): void {
    const textBlocks: Array<{ type: 'text'; text: string }> = [];
    const toolBlocks: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (!isBlock(block)) continue;
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        textBlocks.push({ type: 'text', text: block['text'] });
      }
      if (block['type'] === 'tool_use') toolBlocks.push(block);
    }
    if (textBlocks.length > 0) {
      emit({
        kind: 'assistantCompleted',
        sessionId: input.sessionId,
        runId: input.runId,
        assistantMessageId: messageId,
        content: textBlocks,
      });
    }
    for (const block of toolBlocks) {
      emit({
        kind: 'toolStarted',
        sessionId: input.sessionId,
        runId: input.runId,
        toolUseId: String(block['id'] ?? ''),
        toolName: String(block['name'] ?? ''),
        input: isBlock(block['input']) ? block['input'] : {},
      });
    }
  }

  private mapToolResults(
    content: unknown,
    input: ManagedRunStart,
    emit: (event: AdapterEvent) => void,
  ): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isBlock(block) || block['type'] !== 'tool_result') continue;
      const toolUseId = String(block['tool_use_id'] ?? '');
      const isError = block['is_error'] === true;
      const text = contentToText(block['content']);
      emit({
        kind: 'toolOutput',
        sessionId: input.sessionId,
        runId: input.runId,
        toolUseId,
        text,
      });
      emit({
        kind: 'toolCompleted',
        sessionId: input.sessionId,
        runId: input.runId,
        toolUseId,
        status: isError ? 'failed' : 'succeeded',
        isError,
        summary: text,
      });
    }
  }
}

async function* singleMessage(text: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

function isBlock(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      isBlock(block) && typeof block['text'] === 'string' ? block['text'] : '',
    )
    .join('');
}