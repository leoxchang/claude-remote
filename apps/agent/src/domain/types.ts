import { WorkspaceRecord } from '../workspace/workspace-types.js';

/** 终态 run 状态；进入终态后不再变化。 */
export type TerminalRunStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** run 状态集合；queued 不占执行槽。 */
export const RUN_STATUSES = [
  'queued',
  'starting',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const;

/** 单个 run 的状态。 */
export type RunStatus = (typeof RUN_STATUSES)[number];

/** 会话公开状态；按 lifecycle/activeRun/queue 派生。 */
export type SessionStatus = 'idle' | 'queued' | 'running' | 'archived';

/** 会话生命周期；归档后只读。 */
export type SessionLifecycle = 'active' | 'archived';

/** 可安全序列化为 JSON 的值。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** 协议载荷使用的 JSON 对象。 */
export type JsonObject = { [key: string]: JsonValue };

/** 会话在 Agent 内存中的记录；不是持久记录。 */
export interface SessionRecord {
  sessionId: string;
  workspaceId: string;
  title: string;
  claudeSessionId: string | null;
  lifecycle: SessionLifecycle;
  /** 派生状态缓存；权威来源见 spec §7.2。 */
  status: SessionStatus;
  createdAt: number;
  lastActivityAt: number;
  activeRun: RunRecord | null;
  queue: RunRecord[];
  runsById: ReadonlyMap<string, RunRecord>;
  lastSeq: number;
  lastRunStatus: TerminalRunStatus | null;
}

/** 单次 run 记录；与一次 SDK query 同生命周期。 */
export interface RunRecord {
  runId: string;
  sessionId: string;
  workspaceId: string;
  commandId: string;
  traceId: string;
  /** 只在 queued 与执行期间保留；终态必须置为 null。 */
  text: string | null;
  status: RunStatus;
  enqueueOrder: number;
  enqueuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  errorSummary: string | null;
}

/** 已绑定设备；Mac 只保存令牌哈希。 */
export interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  tokenHash: string;
  createdAt: string;
  revokedAt: string | null;
}

/** 本地配置 agent.json 的结构。 */
export interface AgentConfig {
  version: 1;
  desktopId: string;
  workspace: {
    workspaceId: 'default';
    displayName: string;
    rootPath: string;
  };
  listen: {
    host: '127.0.0.1';
    port: 8787;
  };
  tailscale: {
    baseUrl: string;
  };
}

/** S02 配置结构：多项目 + 每项目队列策略。 */
export interface AgentConfigV2 {
  version: 2;
  desktopId: string;
  workspaces: WorkspaceRecord[];
  listen: {
    host: '127.0.0.1';
    port: 8787;
  };
  tailscale: {
    baseUrl: string;
  };
}