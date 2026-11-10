import { MessageEnvelope } from '@claude-remote/protocol/types';

import { AgentError } from '../command/errors.js';
import { SessionRecord } from '../domain/types.js';
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
      this.session = {
        sessionId: `session_${randomBase64Url(SESSION_ID_BYTES)}`,
        workspaceId: 'default',
        claudeSessionId: null,
        status: 'ready',
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
}