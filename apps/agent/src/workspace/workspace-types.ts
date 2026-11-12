/** 项目级手机审批策略；只能由本机 Unix socket CLI 修改。 */
export type MobileApprovalMode = 'deny' | 'allow_once';

/** 全部合法审批模式；用于严格校验。 */
export const MOBILE_APPROVAL_MODES: readonly MobileApprovalMode[] = [
  'deny',
  'allow_once',
];

/** 迁移与新增项目的默认审批模式：一律先 deny。 */
export const DEFAULT_MOBILE_APPROVAL_MODE: MobileApprovalMode = 'deny';

/** 单个项目的本机策略。 */
export interface WorkspacePolicy {
  perSessionQueueLimit: number;
  mobileApprovalMode: MobileApprovalMode;
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
  mobileApprovalMode: MobileApprovalMode;
}

/** 本机最多授权的项目数。 */
export const MAX_WORKSPACES = 50;

/** 每会话队列上限缺省值。 */
export const DEFAULT_PER_SESSION_QUEUE_LIMIT = 20;

/** 每会话队列上限下界。 */
export const MIN_PER_SESSION_QUEUE_LIMIT = 1;

/** 每会话队列上限上界。 */
export const MAX_PER_SESSION_QUEUE_LIMIT = 20;

/** 只含公开字段的项目摘要。 */
export function toSummary(record: WorkspaceRecord): WorkspaceSummary {
  return {
    workspaceId: record.workspaceId,
    displayName: record.displayName,
    mobileApprovalMode: record.policy.mobileApprovalMode,
  };
}