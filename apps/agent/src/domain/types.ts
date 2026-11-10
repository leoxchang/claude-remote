/** S01 run 状态集合；顺序与状态机一致。 */
export const RUN_STATUSES = [
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

/** 可安全序列化为 JSON 的值。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** 协议载荷使用的 JSON 对象。 */
export type JsonObject = { [key: string]: JsonValue };

/** 会话在 Agent 内存中的状态。 */
export type SessionStatus = 'ready' | 'running';

/** 唯一受管会话的记录；S01 同一进程最多一个。 */
export interface SessionRecord {
  sessionId: string;
  workspaceId: 'default';
  claudeSessionId: string | null;
  status: SessionStatus;
}

/** 单次 run 记录；与一次 SDK query 同生命周期。 */
export interface RunRecord {
  runId: string;
  sessionId: string;
  commandId: string;
  status: RunStatus;
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