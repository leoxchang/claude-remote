import { AgentError } from '../command/errors.js';
import { validateDisplayName } from '../config/config-v2.js';
import { RunRecord, SessionRecord } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';
import { listSessions, SessionListInput, SessionPage } from './session-list.js';
import {
  computeSessionStatus,
  SessionSummary,
  toSessionSummary,
} from './session-summary.js';
import { defaultSessionTitle } from './session-title.js';

const SESSION_ID_BYTES = 12;

/** Claude 映射冲突时的内部摘要；不包含 prompt。 */
const CLAUDE_SESSION_CONFLICT = 'CLAUDE_SESSION_CONFLICT';

/** 会话登记表依赖；时钟与 ID 生成可注入以便测试。 */
export interface SessionRegistryOptions {
  now?: () => number;
  generateId?: () => string;
}

/**
 * 多会话内存登记表。
 *
 * 记录不可变：每次更新返回新对象，调用方拿不到内部引用。
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(options: SessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.generateId =
      options.generateId ??
      (() => `session_${randomBase64Url(SESSION_ID_BYTES)}`);
  }

  /** 只创建本地记录，不启动 SDK query。 */
  create(input: { workspaceId: string; title?: string }): SessionRecord {
    if (input.workspaceId.length === 0) {
      throw new AgentError('INVALID_MESSAGE');
    }
    const now = this.now();
    const record: SessionRecord = {
      sessionId: this.generateId(),
      workspaceId: input.workspaceId,
      title:
        input.title === undefined
          ? defaultSessionTitle(new Date(now))
          : validateDisplayName(input.title),
      claudeSessionId: null,
      lifecycle: 'active',
      status: 'idle',
      createdAt: now,
      lastActivityAt: now,
      activeRun: null,
      queue: [],
      runsById: new Map(),
      lastSeq: 0,
      lastRunStatus: null,
    };
    this.sessions.set(record.sessionId, record);
    return cloneSession(record);
  }

  /** 读取会话副本；未知 ID 报 SESSION_NOT_FOUND。 */
  get(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (record === undefined) throw new AgentError('SESSION_NOT_FOUND');
    return cloneSession(record);
  }

  /** 用 reducer 生成新记录；拒绝改动 sessionId。 */
  update(
    sessionId: string,
    reducer: (current: SessionRecord) => SessionRecord,
  ): SessionRecord {
    const current = this.get(sessionId);
    const next = reducer(current);
    if (next.sessionId !== sessionId) {
      throw new AgentError('INTERNAL_ERROR');
    }
    const stored: SessionRecord = {
      ...next,
      status: computeSessionStatus(next),
      queue: [...next.queue],
    };
    this.sessions.set(sessionId, stored);
    return cloneSession(stored);
  }

  /** S01 session.start 兼容语义：零个创建、一个附着、多个要求选择。 */
  startCompatible(workspaceId: string): SessionRecord {
    const active = [...this.sessions.values()].filter(
      (record) =>
        record.workspaceId === workspaceId && record.lifecycle === 'active',
    );
    if (active.length === 0) return this.create({ workspaceId });
    const first = active[0];
    if (active.length === 1 && first !== undefined) {
      return this.get(first.sessionId);
    }
    throw new AgentError('SESSION_SELECTION_REQUIRED');
  }

  /** 改名不影响映射、Journal 或队列。 */
  rename(sessionId: string, title: string): SessionSummary {
    const displayName = validateDisplayName(title);
    const updated = this.update(sessionId, (current) => ({
      ...current,
      title: displayName,
      lastActivityAt: this.now(),
    }));
    return toSessionSummary(updated);
  }

  /** 归档只改 lifecycle；有活跃或 queued run 时拒绝。 */
  archive(sessionId: string): SessionSummary {
    const current = this.get(sessionId);
    if (current.lifecycle === 'archived') return toSessionSummary(current);
    if (current.activeRun !== null || current.queue.length > 0) {
      throw new AgentError('SESSION_BUSY');
    }
    const updated = this.update(sessionId, (record) => ({
      ...record,
      lifecycle: 'archived',
      lastActivityAt: this.now(),
    }));
    return toSessionSummary(updated);
  }

  /**
   * 绑定本次 run 的 Claude session。
   *
   * 首次绑定直接写入；重复相同值无操作；不同值视为冲突，
   * 保留原映射并把该 run 标为 failed。
   */
  recordClaudeSession(
    sessionId: string,
    runId: string,
    claudeSessionId: string,
  ): void {
    const current = this.get(sessionId);
    if (current.claudeSessionId === claudeSessionId) return;
    if (current.claudeSessionId !== null) {
      this.sessions.set(sessionId, this.failRun(current, runId));
      throw new AgentError('INTERNAL_ERROR');
    }
    this.sessions.set(sessionId, {
      ...current,
      claudeSessionId,
      lastActivityAt: this.now(),
    });
  }

  /** 稳定分页的会话摘要。 */
  listSessions(input: SessionListInput): SessionPage {
    return listSessions([...this.sessions.values()], input);
  }

  /** 当前全部会话副本；调度器扫描用。 */
  all(): SessionRecord[] {
    return [...this.sessions.values()].map(cloneSession);
  }

  /** 返回持有该 run 的 sessionId；未知 run 返回 null。 */
  findRunOwner(runId: string): string | null {
    for (const record of this.sessions.values()) {
      if (record.runsById.has(runId)) return record.sessionId;
    }
    return null;
  }

  private failRun(record: SessionRecord, runId: string): SessionRecord {
    const now = this.now();
    const mark = (run: RunRecord): RunRecord => ({
      ...run,
      status: 'failed',
      text: null,
      endedAt: now,
      errorSummary: CLAUDE_SESSION_CONFLICT,
    });
    const runsById = new Map(record.runsById);
    const existing = runsById.get(runId);
    if (existing !== undefined) runsById.set(runId, mark(existing));
    const activeRun =
      record.activeRun !== null && record.activeRun.runId === runId
        ? mark(record.activeRun)
        : record.activeRun;
    return {
      ...record,
      activeRun,
      runsById,
      status: computeSessionStatus({ ...record, activeRun }),
    };
  }
}

function cloneSession(record: SessionRecord): SessionRecord {
  return { ...record, queue: [...record.queue] };
}