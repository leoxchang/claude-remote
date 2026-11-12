/** 单个项目的本机策略；S02 只有队列上限可配置。 */
export interface WorkspacePolicy {
  perSessionQueueLimit: number;
}

/** 受保护的本地项目记录；rootPath 永不进入 App。 */
export interface WorkspaceRecord {
  workspaceId: string;
  displayName: string;
  rootPath: string;
  createdAt: number;
  policy: WorkspacePolicy;
}

/** 返回给 App 的项目摘要；不含真实路径。 */
export interface WorkspaceSummary {
  workspaceId: string;
  displayName: string;
}

/** 本机最多授权的项目数。 */
export const MAX_WORKSPACES = 50;

/** 每会话队列上限缺省值。 */
export const DEFAULT_PER_SESSION_QUEUE_LIMIT = 20;

/** 每会话队列上限下界。 */
export const MIN_PER_SESSION_QUEUE_LIMIT = 1;

/** 每会话队列上限上界。 */
export const MAX_PER_SESSION_QUEUE_LIMIT = 20;