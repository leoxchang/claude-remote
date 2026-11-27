import { readFileSync } from 'node:fs';

import {
  CanUseTool,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  query,
} from '@anthropic-ai/claude-agent-sdk';

import {
  ImageMediaType,
  RunAttachment,
} from '../attachment/attachment-store.js';
import { SdkPermissionRequest } from '../approval/approval-types.js';
import { AdapterEvent } from '../events/adapter-events.js';
import { baseQueryOptions } from './query-options.js';
import {
  ManagedRunDriver,
  ManagedRunHandle,
  ManagedRunStart,
} from './managed-run-driver.js';

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
  private readonly loadAttachments: (runId: string) => RunAttachment[];

  constructor(
    options: {
      queryFactory?: QueryFactory;
      /** 按 runId 取回已上传图片；未装配时不支持图片。 */
      loadAttachments?: (runId: string) => RunAttachment[];
    } = {},
  ) {
    this.queryFactory =
      options.queryFactory ?? ((params) => query(params));
    this.loadAttachments = options.loadAttachments ?? (() => []);
  }

  /**
   * 每次 run 启动一个新的 query，只包含当前 prompt。
   *
   * 方法同步返回句柄：query 与 Streaming Input 在当前调用栈创建，
   * SDK 事件在 resumeEvents 之前先缓冲。
   */
  startRun(input: ManagedRunStart): ManagedRunHandle {
    const options: Options = {
      ...baseQueryOptions(input.cwd),
      persistSession: true,
      includePartialMessages: true,
      canUseTool: (toolName, toolInput, toolOptions) =>
        input.permissionBroker.request(
          input.runId,
          mapPermissionRequest(toolName, toolInput, toolOptions),
        ),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.claudeSessionId === null
        ? {}
        : { resume: input.claudeSessionId }),
    };
    const q = this.queryFactory({
      prompt: singleMessage(input.text, this.loadAttachments(input.runId)),
      options,
    });
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
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'thinking_delta'
    ) {
      emit({
        kind: 'thinkingDelta',
        sessionId: input.sessionId,
        runId: input.runId,
        assistantMessageId: state.messageId ?? 'msg_unknown',
        contentBlockIndex: event.index,
        text: event.delta.thinking,
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
    const thinkingBlocks: Array<{ type: 'thinking'; text: string }> = [];
    const toolBlocks: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (!isBlock(block)) continue;
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        textBlocks.push({ type: 'text', text: block['text'] });
      }
      if (
        block['type'] === 'thinking' &&
        typeof block['thinking'] === 'string'
      ) {
        thinkingBlocks.push({ type: 'thinking', text: block['thinking'] });
      }
      if (block['type'] === 'tool_use') toolBlocks.push(block);
    }
    if (thinkingBlocks.length > 0) {
      emit({
        kind: 'thinkingCompleted',
        sessionId: input.sessionId,
        runId: input.runId,
        assistantMessageId: messageId,
        content: thinkingBlocks,
      });
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

/** 把 SDK 回调字段复制为本地快照；不读取回调之外的上下文。 */
function mapPermissionRequest(
  toolName: string,
  toolInput: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): SdkPermissionRequest {
  return {
    toolName,
    input: toolInput,
    signal: options.signal,
    toolUseID: options.toolUseID,
    requestId: options.requestId,
    ...(options.agentID === undefined ? {} : { agentID: options.agentID }),
    ...(options.decisionReason === undefined
      ? {}
      : { decisionReason: options.decisionReason }),
    ...(options.defaultToNo === undefined
      ? {}
      : { defaultToNo: options.defaultToNo }),
    ...(options.suppressAlwaysAllowRule === undefined
      ? {}
      : { suppressAlwaysAllowRule: options.suppressAlwaysAllowRule }),
    ...(options.blockedPath === undefined
      ? {}
      : { blockedPath: options.blockedPath }),
    ...(options.mcpServer === undefined
      ? {}
      : { mcpServer: options.mcpServer }),
    ...(options.suggestions === undefined
      ? {}
      : { suggestions: options.suggestions }),
  };
}

/** 文本用字符串，带图片时改用文本块 + 图片块。 */
async function* singleMessage(
  text: string,
  attachments: readonly RunAttachment[],
): AsyncGenerator<SDKUserMessage> {
  const blocks = attachments.flatMap((attachment) => {
    const block = toImageBlock(attachment);
    return block === null ? [] : [block];
  });
  const content =
    blocks.length === 0
      ? text
      : [
          ...(text.length === 0 ? [] : [{ type: 'text' as const, text }]),
          ...blocks,
        ];
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

/** 读取本机图片并编码为 base64；读失败时跳过该张图片。 */
function toImageBlock(attachment: RunAttachment): {
  type: 'image';
  source: { type: 'base64'; media_type: ImageMediaType; data: string };
} | null {
  let data: string;
  try {
    data = readFileSync(attachment.path).toString('base64');
  } catch {
    return null;
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: attachment.mediaType,
      data,
    },
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