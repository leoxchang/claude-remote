import { JsonValue } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';
import {
  ApprovalClock,
  ApprovalContent,
  ApprovalEventSink,
  ApprovalRecord,
  ApprovalResolvedNotice,
  ApprovalRuntimePorts,
  ApprovalStatus,
  ApprovalSummary,
  ApprovalTimers,
  PermissionResult,
  ResolutionReason,
  SdkPermissionRequest,
} from './approval-types.js';
import { ApprovalStore } from './approval-store.js';
import {
  approvalContentDescriptor,
  buildApprovalContent,
} from './approval-content.js';
import {
  classifyPermissionTool,
  clonePermissionInput,
  permissionRequestFingerprint,
} from './permission-request.js';

/** 固定审批有效期：120 秒。 */
export const APPROVAL_TTL_MS = 120_000;

/** 单个 run 的 pending 上限。 */
export const MAX_PENDING_PER_RUN = 8;

/** 全局 pending 上限。 */
export const MAX_GLOBAL_PENDING = 16;

/** 安全拒绝文本；不包含输入正文。 */
export const DENIAL_MESSAGES = {
  unavailable: 'Approval is not available',
  workspaceDisabled: 'Mobile approval is not enabled for this workspace',
  runNotAccepting: 'Run is not accepting approvals',
  deviceInactive: 'Device is not authorized',
  unsupportedTool: 'Tool is not supported for mobile approval',
  unsupportedInteraction: 'User interaction is not supported in S03',
  capacity: 'Too many pending approvals',
  conflict: 'Permission request conflict',
  duplicateAfterResolution: 'Approval already completed; repeated execution blocked',
  expired: 'Approval expired',
  denied: 'User denied',
  invalidated: 'Approval is no longer valid',
} as const;

const APPROVAL_ID_BYTES = 9;

/** Broker 依赖；全部同步，便于在同一调用栈内完成创建与终态。 */
export interface PermissionBrokerOptions {
  store: ApprovalStore;
  ports: ApprovalRuntimePorts;
  events: ApprovalEventSink;
  clock?: ApprovalClock;
  timers?: ApprovalTimers;
  generateApprovalId?: () => string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

/**
 * 审批创建与去重。
 *
 * `request` 不是 async 包装：pending 重入必须返回完全相同的 Promise，
 * 创建、注册、发布与计数更新都在同一同步调用栈内完成。
 */
export class PermissionBroker {
  private readonly store: ApprovalStore;
  private readonly ports: ApprovalRuntimePorts;
  private readonly events: ApprovalEventSink;
  private readonly clock: ApprovalClock;
  private readonly timers: ApprovalTimers;
  private readonly generateApprovalId: () => string;
  private readonly cancelTimers = new Map<string, () => void>();
  private readonly resolvers = new Map<string, (result: PermissionResult) => void>();

  constructor(options: PermissionBrokerOptions) {
    this.store = options.store;
    this.ports = options.ports;
    this.events = options.events;
    this.clock = options.clock ?? {
      monotonicNow: () => performance.now(),
      wallNow: () => Date.now(),
    };
    this.timers = options.timers ?? {
      schedule: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        return () => {
          clearTimeout(handle);
        };
      },
    };
    this.generateApprovalId =
      options.generateApprovalId ??
      (() => `approval_${randomBase64Url(APPROVAL_ID_BYTES)}`);
  }

  /** 接收一个 SDK 权限回调；所有拒绝路径都不创建 App 可见卡片。 */
  request(runId: string, request: SdkPermissionRequest): Promise<PermissionResult> {
    if (request.signal.aborted) {
      return Promise.resolve(this.deny(request.toolUseID, DENIAL_MESSAGES.runNotAccepting));
    }
    const runtime = this.ports.runContext(runId);
    if (runtime === null) {
      return Promise.resolve(this.deny(request.toolUseID, DENIAL_MESSAGES.unavailable));
    }
    if (!runtime.acceptingApprovals) {
      return Promise.resolve(
        this.deny(request.toolUseID, DENIAL_MESSAGES.runNotAccepting),
      );
    }
    if (this.ports.workspaceMode(runtime.context.workspaceId) !== 'allow_once') {
      this.events.reportError({
        code: 'PERMISSION_REQUIRED',
        message: DENIAL_MESSAGES.workspaceDisabled,
      });
      return Promise.resolve(
        this.deny(request.toolUseID, DENIAL_MESSAGES.workspaceDisabled),
      );
    }
    if (!this.ports.deviceActive(runtime.context.deviceId)) {
      this.events.reportError({
        code: 'DEVICE_REVOKED',
        message: DENIAL_MESSAGES.deviceInactive,
      });
      return Promise.resolve(
        this.deny(request.toolUseID, DENIAL_MESSAGES.deviceInactive),
      );
    }

    const classification = classifyPermissionTool(request);
    if (classification.kind === 'unsupported') {
      this.events.reportError({
        code: classification.code,
        message: classification.message,
      });
      return Promise.resolve(this.deny(request.toolUseID, classification.message));
    }

    let input: Record<string, JsonValue>;
    let fingerprint: string;
    try {
      input = clonePermissionInput(request.input);
      fingerprint = permissionRequestFingerprint({ ...request, input });
    } catch {
      this.events.reportError({
        code: 'APPROVAL_CONTENT_UNAVAILABLE',
        message: DENIAL_MESSAGES.unavailable,
      });
      return Promise.resolve(
        this.deny(request.toolUseID, DENIAL_MESSAGES.unavailable),
      );
    }

    const requestKey = `${runId}\u0000${request.requestId}`;
    const existing = this.store.getByRequestKey(requestKey);
    if (existing !== null) {
      if (existing.requestFingerprint !== fingerprint) {
        this.events.reportError({
          code: 'INTERNAL_ERROR',
          message: DENIAL_MESSAGES.conflict,
        });
        return Promise.resolve(this.deny(request.toolUseID, DENIAL_MESSAGES.conflict));
      }
      if (existing.status === 'pending' && existing.resultPromise !== null) {
        return existing.resultPromise;
      }
      if (existing.status === 'approved_once') {
        this.events.reportError({
          code: 'APPROVAL_DUPLICATE_AFTER_RESOLUTION',
          message: DENIAL_MESSAGES.duplicateAfterResolution,
        });
        return Promise.resolve(
          this.deny(request.toolUseID, DENIAL_MESSAGES.duplicateAfterResolution),
        );
      }
      return Promise.resolve(
        this.deny(request.toolUseID, terminalMessage(existing.status)),
      );
    }

    if (this.store.pendingCount(runId) >= MAX_PENDING_PER_RUN) {
      this.events.reportError({
        code: 'APPROVAL_CAPACITY_EXCEEDED',
        message: DENIAL_MESSAGES.capacity,
      });
      return Promise.resolve(this.deny(request.toolUseID, DENIAL_MESSAGES.capacity));
    }
    if (this.store.globalPendingCount() >= MAX_GLOBAL_PENDING) {
      this.events.reportError({
        code: 'APPROVAL_CAPACITY_EXCEEDED',
        message: DENIAL_MESSAGES.capacity,
      });
      return Promise.resolve(this.deny(request.toolUseID, DENIAL_MESSAGES.capacity));
    }

    let content: ApprovalContent;
    try {
      content = buildApprovalContent({
        request: { ...request, input },
        workingDirectory: runtime.context.workingDirectory,
      });
    } catch (error: unknown) {
      const code =
        error instanceof Error && error.message === 'APPROVAL_CONTENT_TOO_LARGE'
          ? 'APPROVAL_CONTENT_TOO_LARGE'
          : 'APPROVAL_CONTENT_UNAVAILABLE';
      this.events.reportError({ code, message: DENIAL_MESSAGES.unavailable });
      return Promise.resolve(
        this.deny(request.toolUseID, DENIAL_MESSAGES.unavailable),
      );
    }

    const approvalId = this.generateApprovalId();
    const createdAt = this.clock.wallNow();
    const expiresAt = createdAt + APPROVAL_TTL_MS;
    const deferred = createDeferred<PermissionResult>();
    const record: ApprovalRecord = Object.freeze({
      approvalId,
      requestKey,
      requestFingerprint: fingerprint,
      workspaceId: runtime.context.workspaceId,
      sessionId: runtime.context.sessionId,
      runId,
      deviceId: runtime.context.deviceId,
      toolUseID: request.toolUseID,
      toolName: request.toolName,
      agentID: request.agentID ?? null,
      status: 'pending',
      createdAt,
      expiresAt,
      resolvedAt: null,
      resolutionReason: null,
      responseCommandId: null,
      content,
      originalInput: input,
      resultPromise: deferred.promise,
    });
    this.store.registerPending(record);
    this.resolvers.set(approvalId, deferred.resolve);
    const cancel = this.timers.schedule(() => {
      this.expire(approvalId);
    }, APPROVAL_TTL_MS);
    this.cancelTimers.set(approvalId, cancel);

    try {
      this.events.requested(toSummary(record, request));
    } catch {
      cancel();
      this.cancelTimers.delete(approvalId);
      this.resolvers.delete(approvalId);
      this.store.removeUncommitted(approvalId);
      this.ports.setPendingApprovalCount(runId, this.store.pendingCount(runId));
      return Promise.resolve(
        this.deny(request.toolUseID, DENIAL_MESSAGES.unavailable),
      );
    }
    this.ports.setPendingApprovalCount(runId, this.store.pendingCount(runId));
    return deferred.promise;
  }

  /** 已存在的 requestKey 重入按保守规则处理；pending 共享原 Promise。 */
  private expire(approvalId: string): void {
    const record = this.store.getById(approvalId);
    if (record === null || record.status !== 'pending') {
      this.clearTimer(approvalId);
      return;
    }
    this.settle(
      record,
      'expired',
      'timeout',
      DENIAL_MESSAGES.expired,
      'cancelled',
    );
  }

  /** 唯一的同步终态入口：先迁移、发事件、计数，再 resolve Promise。 */
  private settle(
    record: ApprovalRecord,
    status: Exclude<ApprovalStatus, 'pending'>,
    reason: ResolutionReason,
    message: string,
    outcome: 'denied' | 'cancelled',
    responseCommandId: string | null = null,
  ): boolean {
    const resolvedAt = this.clock.wallNow();
    const committed = this.store.commitTerminal({
      approvalId: record.approvalId,
      status,
      resolutionReason: reason,
      resolvedAt,
      responseCommandId,
    });
    if (committed === null) return false;
    this.clearTimer(record.approvalId);
    const notice: ApprovalResolvedNotice = {
      approvalId: record.approvalId,
      sessionId: record.sessionId,
      runId: record.runId,
      status,
      resolvedAt,
      resolutionReason: reason,
      responseCommandId,
    };
    this.events.resolved(notice);
    if (status !== 'approved_once') {
      this.events.toolDenied({
        sessionId: record.sessionId,
        runId: record.runId,
        toolUseID: record.toolUseID,
        toolName: record.toolName,
        outcome,
      });
    }
    this.ports.setPendingApprovalCount(
      record.runId,
      this.store.pendingCount(record.runId),
    );
    const resolver = this.resolvers.get(record.approvalId);
    this.resolvers.delete(record.approvalId);
    resolver?.(this.deny(record.toolUseID, message));
    return true;
  }

  private clearTimer(approvalId: string): void {
    const cancel = this.cancelTimers.get(approvalId);
    if (cancel === undefined) return;
    cancel();
    this.cancelTimers.delete(approvalId);
  }

  private deny(toolUseID: string, message: string): PermissionResult {
    return { behavior: 'deny', message, interrupt: false, toolUseID };
  }
}

/** 终态重入对应的安全 denial 文本。 */
function terminalMessage(status: ApprovalStatus): string {
  switch (status) {
    case 'expired':
      return DENIAL_MESSAGES.expired;
    case 'denied':
      return DENIAL_MESSAGES.denied;
    case 'approved_once':
      return DENIAL_MESSAGES.duplicateAfterResolution;
    case 'invalidated':
      return DENIAL_MESSAGES.invalidated;
    default:
      return DENIAL_MESSAGES.unavailable;
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      resolveFn(value);
    },
  };
}

/** 生成公开摘要；仅含安全字段与内容描述。 */
function toSummary(
  record: ApprovalRecord,
  request: SdkPermissionRequest,
): ApprovalSummary {
  if (record.content === null) {
    throw new Error('pending approval must carry content');
  }
  return {
    approvalId: record.approvalId,
    toolUseID: record.toolUseID,
    toolName: record.toolName,
    agentID: record.agentID,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    defaultToNo: request.defaultToNo === true,
    hasDecisionReason: request.decisionReason !== undefined,
    hasBlockedPath: request.blockedPath !== undefined,
    content: approvalContentDescriptor(record.content),
  };
}