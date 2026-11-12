import { JsonValue } from '../domain/types.js';

/** S03 支持的普通权限工具；其他工具一律 fail closed。 */
export const SUPPORTED_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
]);

/** 不支持的结构化交互工具名。 */
export const UNSUPPORTED_INTERACTION_TOOL = 'AskUserQuestion';

/** 不支持的交互统一拒绝文本；不含任何输入正文。 */
export const UNSUPPORTED_INTERACTION_MESSAGE =
  'User interaction is not supported in S03';

/** 本地 SDK 权限请求快照；SDK 类型只出现在 Adapter 边界。 */
export interface SdkPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  toolUseID: string;
  requestId: string;
  agentID?: string;
  decisionReason?: string;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
  blockedPath?: string;
  mcpServer?: { name: string; source: string };
  suggestions?: unknown[];
}

/** 返回 Runtime 的权限结果；不含 updatedPermissions 或 suggestions。 */
export type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput: Record<string, JsonValue>;
      toolUseID: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt: false;
      toolUseID: string;
    };

/** 工具分类结果；不支持时给出稳定错误码与安全文本。 */
export type PermissionToolClassification =
  | { kind: 'supported' }
  | {
      kind: 'unsupported';
      code: 'APPROVAL_TOOL_UNSUPPORTED' | 'UNSUPPORTED_USER_INTERACTION';
      message: string;
    };

/** 审批终态。 */
export type ApprovalStatus =
  | 'pending'
  | 'approved_once'
  | 'denied'
  | 'expired'
  | 'invalidated';

/** 终态原因。 */
export type ResolutionReason =
  | 'user_allow_once'
  | 'user_deny'
  | 'timeout'
  | 'run_cancelled'
  | 'sdk_aborted'
  | 'policy_disabled'
  | 'device_revoked'
  | 'agent_shutdown';

/** 单份完整审批内容；仅 pending 期间保存在内存。 */
export interface ApprovalContent {
  encoding: 'json-utf8';
  jsonText: string;
  chunks: readonly string[];
  byteLength: number;
  sha256: string;
}

/** 协议可公开的内容描述；不含正文。 */
export interface ApprovalContentDescriptor {
  encoding: 'json-utf8';
  byteLength: number;
  sha256: string;
  chunkCount: number;
}

/** 内容 endpoint 的单块响应。 */
export interface ApprovalChunkResponse {
  approvalId: string;
  chunkIndex: number;
  chunkCount: number;
  encoding: 'json-utf8';
  byteLength: number;
  sha256: string;
  text: string;
}

/** 审批与 run/session/workspace/device 的绑定信息。 */
export interface RunApprovalContext {
  workspaceId: string;
  sessionId: string;
  runId: string;
  deviceId: string;
  workingDirectory: string;
}

/** 内存审批记录；终态后 content/originalInput/resultPromise 必须为 null。 */
export interface ApprovalRecord {
  approvalId: string;
  requestKey: string;
  requestFingerprint: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  deviceId: string;
  toolUseID: string;
  toolName: string;
  agentID: string | null;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  resolutionReason: ResolutionReason | null;
  responseCommandId: string | null;
  content: ApprovalContent | null;
  originalInput: Record<string, JsonValue> | null;
  resultPromise: Promise<PermissionResult> | null;
}

/** 终态后保留的安全审计；不含正文。 */
export interface ApprovalAuditRecord {
  approvalId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  deviceId: string;
  toolUseID: string;
  toolName: string;
  requestFingerprint: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
  resolutionReason: ResolutionReason | null;
  contentByteLength: number | null;
  contentSha256: string | null;
}

/** 发给 App 的安全审批摘要；不含正文。 */
export interface ApprovalSummary {
  approvalId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  toolUseID: string;
  toolName: string;
  agentID: string | null;
  createdAt: number;
  expiresAt: number;
  defaultToNo: boolean;
  hasDecisionReason: boolean;
  hasBlockedPath: boolean;
  content: ApprovalContentDescriptor;
}

/** 终态通知；responseCommandId 只在用户响应时存在。 */
export interface ApprovalResolvedNotice {
  approvalId: string;
  sessionId: string;
  runId: string;
  status: Exclude<ApprovalStatus, 'pending'>;
  resolvedAt: number;
  resolutionReason: ResolutionReason;
  responseCommandId: string | null;
}

/** 只能出现安全字段的错误通知；已知上下文时附带关联 ID。 */
export interface ApprovalSafeError {
  code: string;
  message: string;
  sessionId?: string;
  runId?: string;
}

/** 工具请求被拒绝/取消的事件载荷；用于补一次 tool.completed。 */
export interface ToolDeniedNotice {
  sessionId: string;
  runId: string;
  toolUseID: string | undefined;
  toolName: string;
  outcome: 'denied' | 'cancelled';
}

/** Broker 读取的运行时状态端口；所有方法必须同步。 */
export interface ApprovalRuntimePorts {
  runContext(
    runId: string,
  ): { context: RunApprovalContext; acceptingApprovals: boolean } | null;
  workspaceMode(workspaceId: string): 'deny' | 'allow_once';
  deviceActive(deviceId: string): boolean;
  setPendingApprovalCount(runId: string, count: number): void;
}

/** Broker 发布事件端口；所有方法同步且只接受安全字段。 */
export interface ApprovalEventSink {
  requested(summary: ApprovalSummary): void;
  resolved(notice: ApprovalResolvedNotice): void;
  reportError(error: ApprovalSafeError): void;
  toolDenied(notice: ToolDeniedNotice): void;
}

/** 单调时钟与墙钟分开；TTL 只依赖 monotonic。 */
export interface ApprovalClock {
  monotonicNow(): number;
  wallNow(): number;
}

/** 可注入的定时器；返回取消函数。 */
export interface ApprovalTimers {
  schedule(callback: () => void, delayMs: number): () => void;
}

/** permission.respond 的已认证输入；所有关联 ID 必须同时匹配。 */
export interface PermissionResponseInput {
  approvalId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  deviceId: string;
  commandId: string;
  decision: 'allow_once' | 'deny';
}

/** permission.respond 的同步结果。 */
export interface PermissionResponseResult {
  approvalId: string;
  status: 'approved_once' | 'denied';
  resolvedAt: number;
}