import { MessageEnvelope } from '@claude-remote/protocol/types';

import { AgentError } from '../command/errors.js';
import { SessionRecord, SessionStatus } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';

const SESSION_ID_BYTES = 12;

/** session.start 的结果。 */
export interface SessionStartResult {
  sessionId: string;
  claudeSessionId: string | null;
  status: string;
}

/** prompt.send / run.cancel 被接受的结果。 */
export interface RunAccepted {
  sessionId: string;
  runId: string;
  status: 'starting' | 'cancelling';
}

/** session.snapshot 事件；payload 由 SnapshotFactory 填充。 */
export interface SessionSnapshotEvent extends MessageEnvelope {
  type: 'session.snapshot';
  payload: Record<string, unknown>;
}

/** 命令层依赖的全部操作；由运行时实现。 */
export interface AgentOperations {
  startSession(workspaceId: string): Promise<SessionStartResult>;
  sendPrompt(
    sessionId: string,
    text: string,
    commandId: string,
  ): Promise<RunAccepted>;
  cancelRun(sessionId: string, runId: string): Promise<RunAccepted>;
  snapshot(sessionId: string): Promise<SessionSnapshotEvent>;
}

/** 只持有固定 workspace 的唯一会话；不启动 SDK query。 */
export class SessionController {
  private session: SessionRecord | null = null;

  /** 附着语义：已有会话时返回同一个，不清空任何状态。 */
  async start(workspaceId: string): Promise<SessionRecord> {
    if (workspaceId !== 'default') {
      throw new AgentError('WORKSPACE_NOT_ALLOWED');
    }
    if (this.session === null) {
      const now = Date.now();
      this.session = {
        sessionId: `session_${randomBase64Url(SESSION_ID_BYTES)}`,
        workspaceId: 'default',
        title: defaultSessionTitle(new Date(now)),
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
    }
    return { ...this.session };
  }

  /** 读取当前会话；不存在或 ID 不匹配时报 SESSION_NOT_FOUND。 */
  get(sessionId: string): SessionRecord {
    const session = this.session;
    if (session === null || session.sessionId !== sessionId) {
      throw new AgentError('SESSION_NOT_FOUND');
    }
    return { ...session };
  }

  /** 更新会话的 claudeSessionId 或状态；返回新副本。 */
  update(
    sessionId: string,
    changes: { claudeSessionId?: string | null; status?: SessionStatus },
  ): SessionRecord {
    const current = this.get(sessionId);
    this.session = { ...current, ...changes };
    return { ...this.session };
  }
}

/** 默认标题：本机时间 `会话 YYYY-MM-DD HH:mm`，允许重名。 */
function defaultSessionTitle(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    `会话 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  ].join(' ');
}