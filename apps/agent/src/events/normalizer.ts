import { JsonObject } from '../domain/types.js';
import { AdapterEvent, TimelineEvent } from './adapter-events.js';
import { EventJournal } from './journal.js';
import { truncateUtf8 } from './utf8.js';

/** delta 合并的默认时间窗口。 */
export const DELTA_FLUSH_MS = 50;

/** delta 合并的默认字节上限。 */
export const DELTA_FLUSH_BYTES = 16 * 1024;

/** message.completed 携带完整正文的字节上限。 */
export const COMPLETED_BODY_BYTES = 32 * 1024;

/** 工具输入预览的字节上限。 */
export const TOOL_INPUT_BYTES = 16 * 1024;

/** 单块工具输出的字节上限。 */
export const TOOL_OUTPUT_BYTES = 32 * 1024;

/** 工具完成摘要的字节上限。 */
export const TOOL_SUMMARY_BYTES = 4 * 1024;

interface PendingDelta {
  sessionId: string;
  runId: string;
  assistantMessageId: string;
  contentBlockIndex: number;
  text: string;
}

/** 把 AdapterEvent 归一化为协议事件并写入 Journal。 */
export class EventNormalizer {
  private pending: PendingDelta | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly startedTools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly deniedOutcomes = new Map<string, 'denied' | 'cancelled'>();
  private readonly deltaSeq = new Map<string, number>();
  private readonly outputSeq = new Map<string, number>();

  constructor(private readonly journal: EventJournal) {}

  /** 消费一个 adapter 事件。 */
  consume(event: AdapterEvent): void {
    if (event.kind !== 'textDelta' && event.kind !== 'toolOutput') {
      this.flush();
    }
    switch (event.kind) {
      case 'init':
        this.append(event, 'session.status', {
          state: 'running',
          claudeSessionId: event.claudeSessionId,
          activeRunId: event.runId,
        });
        break;
      case 'textDelta':
        this.handleDelta(event);
        break;
      case 'assistantCompleted':
        this.handleCompleted(event);
        break;
      case 'toolStarted': {
        const key = toolKey(event);
        this.startedTools.add(key);
        this.append(event, 'tool.started', this.toolStartedPayload(event));
        const denied = this.deniedOutcomes.get(key);
        if (denied !== undefined) {
          this.deniedOutcomes.delete(key);
          this.appendManagedOutcome({
            sessionId: event.sessionId,
            runId: event.runId,
            toolUseId: event.toolUseId,
            outcome: denied,
          });
        }
        break;
      }
      case 'toolOutput':
        this.append(event, 'tool.output', this.toolOutputPayload(event));
        break;
      case 'toolCompleted': {
        const key = toolKey(event);
        if (this.completedTools.has(key)) break;
        this.startedTools.delete(key);
        this.appendToolCompleted(event);
        break;
      }
      case 'permissionDenied':
        this.handlePermissionDenied(event);
        break;
      case 'runResult':
        this.append(event, 'run.completed', {
          status: event.status,
          ...(event.errorSummary === undefined
            ? {}
            : { errorSummary: event.errorSummary }),
        });
        break;
      default:
        break;
    }
  }

  /** 立即写出待发送的 delta。 */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    const key = `${pending.assistantMessageId}:${pending.contentBlockIndex}`;
    const nextSeq = (this.deltaSeq.get(key) ?? 0) + 1;
    this.deltaSeq.set(key, nextSeq);
    this.journal.append({
      sessionId: pending.sessionId,
      type: 'message.delta',
      payload: {
        assistantMessageId: pending.assistantMessageId,
        text: pending.text,
        index: pending.contentBlockIndex,
        deltaSeq: nextSeq,
      },
      runId: pending.runId,
    });
  }

  private handleDelta(
    event: Extract<AdapterEvent, { kind: 'textDelta' }>,
  ): void {
    const pending = this.pending;
    if (
      pending !== null &&
      (pending.assistantMessageId !== event.assistantMessageId ||
        pending.contentBlockIndex !== event.contentBlockIndex)
    ) {
      this.flush();
    }
    const current = this.pending ?? {
      sessionId: event.sessionId,
      runId: event.runId,
      assistantMessageId: event.assistantMessageId,
      contentBlockIndex: event.contentBlockIndex,
      text: '',
    };
    this.pending = { ...current, text: current.text + event.text };
    if (Buffer.byteLength(this.pending.text, 'utf8') >= DELTA_FLUSH_BYTES) {
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, DELTA_FLUSH_MS);
  }

  private handleCompleted(
    event: Extract<AdapterEvent, { kind: 'assistantCompleted' }>,
  ): void {
    const text = event.content.map((block) => block.text).join('');
    const fits = Buffer.byteLength(text, 'utf8') <= COMPLETED_BODY_BYTES;
    this.append(event, 'message.completed', {
      assistantMessageId: event.assistantMessageId,
      text: fits ? text : '',
      content: fits ? event.content : [],
      contentTruncated: !fits,
      ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
    });
  }

  private toolStartedPayload(
    event: Extract<AdapterEvent, { kind: 'toolStarted' }>,
  ): JsonObject {
    const serialized = JSON.stringify(event.input);
    const fits = Buffer.byteLength(serialized, 'utf8') <= TOOL_INPUT_BYTES;
    return fits
      ? {
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input as JsonObject,
          inputTruncated: false,
        }
      : {
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: {},
          inputTruncated: true,
        };
  }

  private toolOutputPayload(
    event: Extract<AdapterEvent, { kind: 'toolOutput' }>,
  ): JsonObject {
    const truncated = truncateUtf8(event.text, TOOL_OUTPUT_BYTES);
    const nextSeq = (this.outputSeq.get(event.toolUseId) ?? 0) + 1;
    this.outputSeq.set(event.toolUseId, nextSeq);
    return {
      toolUseId: event.toolUseId,
      chunk: truncated.text,
      chunkSeq: nextSeq,
      truncated: truncated.truncated,
    };
  }

  private handlePermissionDenied(
    event: Extract<AdapterEvent, { kind: 'permissionDenied' }>,
  ): void {
    if (event.toolUseId === undefined) return;
    const key = `${event.runId}\u0000${event.toolUseId}`;
    if (this.startedTools.has(key)) {
      this.appendManagedOutcome({
        sessionId: event.sessionId,
        runId: event.runId,
        toolUseId: event.toolUseId,
        outcome: event.outcome,
      });
      return;
    }
    this.deniedOutcomes.set(key, event.outcome);
  }

  /** 清理 run 的短期工具状态；run 关闭后不再复用。 */
  clearRun(runId: string): void {
    const prefix = `${runId}\u0000`;
    for (const key of [...this.startedTools]) {
      if (key.startsWith(prefix)) this.startedTools.delete(key);
    }
    for (const key of [...this.completedTools]) {
      if (key.startsWith(prefix)) this.completedTools.delete(key);
    }
    for (const key of [...this.deniedOutcomes.keys()]) {
      if (key.startsWith(prefix)) this.deniedOutcomes.delete(key);
    }
  }

  private appendToolCompleted(
    event: Extract<AdapterEvent, { kind: 'toolCompleted' }>,
  ): void {
    this.completedTools.add(`${event.runId}\u0000${event.toolUseId}`);
    this.append(event, 'tool.completed', {
      toolUseId: event.toolUseId,
      status: event.status,
      isError: event.isError,
      summary: truncateUtf8(event.summary, TOOL_SUMMARY_BYTES).text,
    });
  }

  /** 补一次且只补一次 denied/cancelled 完成事件。 */
  private appendManagedOutcome(input: {
    sessionId: string;
    runId: string;
    toolUseId: string;
    outcome: 'denied' | 'cancelled';
  }): void {
    const key = `${input.runId}\u0000${input.toolUseId}`;
    if (this.completedTools.has(key)) return;
    this.completedTools.add(key);
    this.startedTools.delete(key);
    this.deniedOutcomes.delete(key);
    this.journal.append({
      sessionId: input.sessionId,
      runId: input.runId,
      type: 'tool.completed',
      payload: {
        toolUseId: input.toolUseId,
        status: input.outcome,
        isError: true,
        summary:
          input.outcome === 'denied'
            ? 'denied by approval'
            : 'cancelled by approval',
      },
    });
  }

  private append(
    event: AdapterEvent,
    type: string,
    payload: JsonObject,
  ): TimelineEvent {
    return this.journal.append({
      sessionId: event.sessionId,
      type,
      payload,
      runId: event.runId,
    });
  }
}

/** run 维度工具键；同一 toolUseId 在不同 run 中互不影响。 */
function toolKey(event: { runId: string; toolUseId: string }): string {
  return `${event.runId}\u0000${event.toolUseId}`;
}