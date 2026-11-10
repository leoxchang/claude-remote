import { JsonObject, RunRecord, SessionRecord } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';
import { SessionSnapshotEvent } from '../session/session-controller.js';
import { TimelineEvent } from './adapter-events.js';
import { EventJournal } from './journal.js';
import { truncateUtf8 } from './utf8.js';

/** 快照最多包含的事件条数。 */
export const MAX_SNAPSHOT_EVENTS = 200;

/** 快照 payload 的字节预算。 */
export const SNAPSHOT_PAYLOAD_BUDGET = 48 * 1024;

/** 助手消息预览的字节上限。 */
export const MESSAGE_PREVIEW_BYTES = 8 * 1024;

/** 工具输出预览的字节上限。 */
export const TOOL_OUTPUT_PREVIEW_BYTES = 4 * 1024;

const MESSAGE_ID_BYTES = 9;

/** 构造快照所需的当前状态。 */
export interface SnapshotInput {
  session: SessionRecord;
  activeRun: RunRecord | null;
  journal: EventJournal;
}

interface ProjectedEvent {
  event: TimelineEvent;
  size: number;
}

/** 在固定预算内生成最近摘要快照；不修改 Journal。 */
export class SnapshotFactory {
  /** 生成 session.snapshot 事件。 */
  create(input: SnapshotInput): SessionSnapshotEvent {
    const all = input.journal.recent(input.session.sessionId, Number.MAX_SAFE_INTEGER);
    const projected = project(all);
    const lastSeq = input.journal.lastSeq(input.session.sessionId);

    const fixed = {
      session: {
        sessionId: input.session.sessionId,
        claudeSessionId: input.session.claudeSessionId,
        workspaceId: input.session.workspaceId,
        status: input.session.status,
      },
      activeRun:
        input.activeRun === null
          ? null
          : {
              runId: input.activeRun.runId,
              status: input.activeRun.status,
              commandId: input.activeRun.commandId,
            },
      lastRunStatus: lastRunStatus(all, input.activeRun),
      lastSeq,
    };
    const baseSize = Buffer.byteLength(
      JSON.stringify({ ...fixed, recentEvents: [], oldestIncludedSeq: null, snapshotTruncated: false }),
      'utf8',
    );

    const selected: TimelineEvent[] = [];
    let used = 0;
    let dropped = projected.length < all.length;
    for (const entry of [...projected].reverse()) {
      if (selected.length >= MAX_SNAPSHOT_EVENTS) {
        dropped = true;
        break;
      }
      if (baseSize + used + entry.size + 1 > SNAPSHOT_PAYLOAD_BUDGET) {
        dropped = true;
        break;
      }
      selected.push(entry.event);
      used += entry.size + 1;
    }
    selected.reverse();

    let payload: Record<string, unknown> = {
      ...fixed,
      recentEvents: selected,
      oldestIncludedSeq: selected[0]?.seq ?? null,
      snapshotTruncated: dropped,
    };
    while (
      Buffer.byteLength(JSON.stringify(payload), 'utf8') >
        SNAPSHOT_PAYLOAD_BUDGET &&
      selected.length > 0
    ) {
      selected.shift();
      payload = {
        ...fixed,
        recentEvents: selected,
        oldestIncludedSeq: selected[0]?.seq ?? null,
        snapshotTruncated: true,
      };
    }

    return {
      protocolVersion: 1,
      messageId: `msg_${randomBase64Url(MESSAGE_ID_BYTES)}`,
      timestamp: Date.now(),
      type: 'session.snapshot',
      payload,
    };
  }
}

function lastRunStatus(
  events: readonly TimelineEvent[],
  activeRun: RunRecord | null,
): string | null {
  if (activeRun !== null) return activeRun.status;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'run.completed') continue;
    const status = (event.payload as Record<string, unknown>)['status'];
    return typeof status === 'string' ? status : null;
  }
  return null;
}

/** 按 spec §12.1 的投影规则生成可放入预算的事件预览。 */
function project(events: readonly TimelineEvent[]): ProjectedEvent[] {
  const completedMessages = new Set<string>();
  for (const event of events) {
    if (event.type !== 'message.completed') continue;
    const id = (event.payload as Record<string, unknown>)['assistantMessageId'];
    if (typeof id === 'string') completedMessages.add(id);
  }

  const latestOutput = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.type !== 'tool.output') return;
    const toolUseId = (event.payload as Record<string, unknown>)['toolUseId'];
    if (typeof toolUseId === 'string') latestOutput.set(toolUseId, index);
  });

  const remainingDeltaBytes = new Map<string, number>();
  const projected: ProjectedEvent[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    const preview = projectOne(
      event,
      index,
      completedMessages,
      latestOutput,
      remainingDeltaBytes,
    );
    if (preview !== null) projected.push(preview);
  }
  projected.reverse();
  return projected;
}

function projectOne(
  event: TimelineEvent,
  index: number,
  completedMessages: ReadonlySet<string>,
  latestOutput: ReadonlyMap<string, number>,
  remainingDeltaBytes: Map<string, number>,
): ProjectedEvent | null {
  const payload = { ...(event.payload as JsonObject) };
  switch (event.type) {
    case 'message.delta': {
      const messageId = String(payload['assistantMessageId'] ?? '');
      if (completedMessages.has(messageId)) return null;
      const budget = remainingDeltaBytes.get(messageId) ?? MESSAGE_PREVIEW_BYTES;
      if (budget <= 0) return null;
      const text = truncateUtf8(String(payload['text'] ?? ''), budget);
      payload['text'] = text.text;
      remainingDeltaBytes.set(
        messageId,
        budget - Buffer.byteLength(text.text, 'utf8'),
      );
      return projected(event, payload);
    }
    case 'message.completed': {
      const text = truncateUtf8(
        String(payload['text'] ?? ''),
        MESSAGE_PREVIEW_BYTES,
      );
      payload['text'] = text.text;
      payload['contentTruncated'] = text.truncated || payload['contentTruncated'] === true;
      return projected(event, payload);
    }
    case 'tool.output': {
      const toolUseId = String(payload['toolUseId'] ?? '');
      if (latestOutput.get(toolUseId) !== index) return null;
      const chunk = truncateUtf8(
        String(payload['chunk'] ?? ''),
        TOOL_OUTPUT_PREVIEW_BYTES,
      );
      payload['chunk'] = chunk.text;
      payload['truncated'] = true;
      return projected(event, payload);
    }
    case 'tool.started': {
      payload['input'] = {};
      payload['inputOmittedInSnapshot'] = true;
      return projected(event, payload);
    }
    default:
      return projected(event, payload);
  }
}

function projected(event: TimelineEvent, payload: JsonObject): ProjectedEvent {
  const preview: TimelineEvent = { ...event, payload };
  return {
    event: preview,
    size: Buffer.byteLength(JSON.stringify(preview), 'utf8'),
  };
}