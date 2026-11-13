import { AgentError } from '../command/errors.js';
import { JsonValue } from '../domain/types.js';
import { randomBase64Url } from '../security/random.js';
import { StorageHealth } from '../storage/storage-health.js';
import {
  approvalContentDescriptor,
  buildApprovalContent,
} from './approval-content.js';
import { DurableApprovalStore } from './durable-approval-store.js';
import { toApprovalSummary } from './approval-summary.js';
import {
  classifyPermissionTool,
  clonePermissionInput,
  permissionRequestFingerprint,
} from './permission-request.js';
import {
  ApprovalClock,
  ApprovalContent,
  ApprovalRecord,
  ApprovalRuntimePorts,
  ApprovalSafeError,
  ApprovalStatus,
  ApprovalTimers,
  PermissionResponseInput,
  PermissionResponseResult,
  PermissionResult,
  ResolutionReason,
  SdkPermissionRequest,
  ToolDeniedNotice,
} from './approval-types.js';
import {
  APPROVAL_TTL_MS,
  DENIAL_MESSAGES,
  MAX_GLOBAL_PENDING,
  MAX_PENDING_PER_RUN,
} from './permission-broker.js';

const APPROVAL_ID_BYTES = 9;

/** 只保留非事务型通知；requested/resolved 由 DurableApprovalStore 写入。 */
export interface DurableApprovalEvents {
  reportError(error: ApprovalSafeError): void;
  toolDenied(notice: ToolDeniedNotice): void;
}

export interface DurablePermissionBrokerOptions {
  store: DurableApprovalStore;
  health: StorageHealth;
  ports: ApprovalRuntimePorts;
  events: DurableApprovalEvents;
  clock?: ApprovalClock;
  timers?: ApprovalTimers;
  generateApprovalId?: () => string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

/**
 * DB 审批 Broker。
 *
 * 正文先注册内存，再单事务提交审批行与 requested；任何存储失败立即
 * deny、清正文并降级，绝不悬挂 canUseTool Promise。
 */
export class DurablePermissionBroker {
  private readonly store: DurableApprovalStore;
  private readonly health: StorageHealth;
  private readonly ports: ApprovalRuntimePorts;
  private readonly events: DurableApprovalEvents;
  private readonly clock: ApprovalClock;
  private readonly timers: ApprovalTimers;
  private readonly generateApprovalId: () => string;
  private readonly cancelTimers = new Map<string, () => void>();
  private readonly resolvers = new Map<string, (result: PermissionResult) => void>();
  private readonly deadlines = new Map<string, number>();

  constructor(options: DurablePermissionBrokerOptions) {
    this.store = options.store;
    this.health = options.health;
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

  request(runId: string, request: SdkPermissionRequest): Promise<PermissionResult> {
    if (!this.health.isAvailable()) {
      return Promise.resolve(
        this.deny(request.toolUseID, DENIAL_MESSAGES.storageUnavailable),
      );
    }
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
      this.reportError(runtime.context, runId, 'PERMISSION_REQUIRED', DENIAL_MESSAGES.workspaceDisabled);
      return Promise.resolve(
        this.deny(request.toolUseID, DENIAL_MESSAGES.workspaceDisabled),
      );
    }
    if (!this.ports.deviceActive(runtime.context.deviceId)) {
      this.reportError(runtime.context, runId, 'DEVICE_REVOKED', DENIAL_MESSAGES.deviceInactive);
      return Promise.resolve(
        this.deny(request.toolUseID, DENIAL_MESSAGES.deviceInactive),
      );
    }

    const classification = classifyPermissionTool(request);
    if (classification.kind === 'unsupported') {
      this.reportError(runtime.context, runId, classification.code, classification.message);
      return Promise.resolve(this.deny(request.toolUseID, classification.message));
    }

    let input: Record<string, JsonValue>;
    let fingerprint: string;
    try {
      input = clonePermissionInput(request.input);
      fingerprint = permissionRequestFingerprint({ ...request, input });
    } catch {
      this.reportError(runtime.context, runId, 'APPROVAL_CONTENT_UNAVAILABLE', DENIAL_MESSAGES.unavailable);
      return Promise.resolve(
        this.deny(request.toolUseID, DENIAL_MESSAGES.unavailable),
      );
    }

    const requestKey = `${runId}\u0000${request.requestId}`;
    const existing = this.store.getByRequestKey(requestKey);
    if (existing !== null) {
      if (existing.requestFingerprint !== fingerprint) {
        this.reportError(existing, runId, 'INTERNAL_ERROR', DENIAL_MESSAGES.conflict);
        return Promise.resolve(this.deny(request.toolUseID, DENIAL_MESSAGES.conflict));
      }
      if (existing.status === 'pending' && existing.resultPromise !== null) {
        return existing.resultPromise;
      }
      if (existing.status === 'approved_once') {
        this.reportError(existing, runId, 'APPROVAL_DUPLICATE_AFTER_RESOLUTION', DENIAL_MESSAGES.duplicateAfterResolution);
        return Promise.resolve(
          this.deny(request.toolUseID, DENIAL_MESSAGES.duplicateAfterResolution),
        );
      }
      return Promise.resolve(
        this.deny(request.toolUseID, terminalMessage(existing.status)),
      );
    }

    if (this.store.pendingCount(runId) >= MAX_PENDING_PER_RUN) {
      this.reportError(runtime.context, runId, 'APPROVAL_CAPACITY_EXCEEDED', DENIAL_MESSAGES.capacity);
      return Promise.resolve(this.deny(request.toolUseID, DENIAL_MESSAGES.capacity));
    }
    if (this.store.globalPendingCount() >= MAX_GLOBAL_PENDING) {
      this.reportError(runtime.context, runId, 'APPROVAL_CAPACITY_EXCEEDED', DENIAL_MESSAGES.capacity);
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
      this.reportError(runtime.context, runId, code, DENIAL_MESSAGES.unavailable);
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
      defaultToNo: request.defaultToNo === true,
      hasDecisionReason: request.decisionReason !== undefined,
      hasBlockedPath: request.blockedPath !== undefined,
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
    const summary = toApprovalSummary(record, approvalContentDescriptor(content));

    this.store.registerPending(record, {
      content,
      originalInput: input,
      resultPromise: deferred.promise,
    });
    this.resolvers.set(approvalId, deferred.resolve);
    this.deadlines.set(approvalId, this.clock.monotonicNow() + APPROVAL_TTL_MS);
    try {
      this.store.commitRequested(record, summary);
    } catch {
      this.store.removeUncommitted(approvalId);
      this.resolvers.delete(approvalId);
      this.deadlines.delete(approvalId);
      this.health.degraded('unavailable');
      this.reportError(runtime.context, runId, 'STORAGE_UNAVAILABLE', DENIAL_MESSAGES.storageUnavailable);
      return Promise.resolve(
        this.deny(request.toolUseID, DENIAL_MESSAGES.storageUnavailable),
      );
    }
    const cancel = this.timers.schedule(() => {
      this.expire(approvalId);
    }, APPROVAL_TTL_MS);
    this.cancelTimers.set(approvalId, cancel);
    this.ports.setPendingApprovalCount(runId, this.store.pendingCount(runId));
    return deferred.promise;
  }

  /** 用户响应；同一事务提交终态与 resolved，commit 后才 resolve。 */
  respond(input: PermissionResponseInput): PermissionResponseResult {
    this.settleIfExpired(input.approvalId);
    const record = this.store.getById(input.approvalId);
    if (record === null) throw new AgentError('APPROVAL_NOT_FOUND');
    if (
      record.workspaceId !== input.workspaceId ||
      record.sessionId !== input.sessionId ||
      record.runId !== input.runId
    ) {
      throw new AgentError('APPROVAL_SESSION_MISMATCH');
    }
    if (record.deviceId !== input.deviceId) throw new AgentError('FORBIDDEN');
    if (record.status !== 'pending') {
      throw new AgentError(
        record.status === 'expired'
          ? 'APPROVAL_EXPIRED'
          : 'APPROVAL_ALREADY_RESOLVED',
      );
    }
    if (this.ports.workspaceMode(record.workspaceId) !== 'allow_once') {
      this.settleWithFailurePolicy(
        record,
        'invalidated',
        'policy_disabled',
        this.deny(record.toolUseID, DENIAL_MESSAGES.policyDisabled),
        'denied',
      );
      throw new AgentError('APPROVAL_ALREADY_RESOLVED');
    }
    if (!this.ports.deviceActive(record.deviceId)) {
      this.settleWithFailurePolicy(
        record,
        'invalidated',
        'device_revoked',
        this.deny(record.toolUseID, DENIAL_MESSAGES.deviceRevoked),
        'denied',
      );
      throw new AgentError('FORBIDDEN');
    }
    if (input.decision === 'allow_once') {
      const updatedInput = record.originalInput;
      if (updatedInput === null) {
        throw new AgentError('APPROVAL_CONTENT_UNAVAILABLE');
      }
      const resolvedAt = this.settle(
        record,
        'approved_once',
        'user_allow_once',
        { behavior: 'allow', updatedInput, toolUseID: record.toolUseID },
        'denied',
        input.commandId,
      );
      if (resolvedAt === null) throw new AgentError('APPROVAL_ALREADY_RESOLVED');
      return { approvalId: record.approvalId, status: 'approved_once', resolvedAt };
    }
    const resolvedAt = this.settle(
      record,
      'denied',
      'user_deny',
      this.deny(record.toolUseID, DENIAL_MESSAGES.denied),
      'denied',
      input.commandId,
    );
    if (resolvedAt === null) throw new AgentError('APPROVAL_ALREADY_RESOLVED');
    return { approvalId: record.approvalId, status: 'denied', resolvedAt };
  }

  settleIfExpired(approvalId: string): ApprovalRecord | null {
    const record = this.store.getById(approvalId);
    if (record === null || record.status !== 'pending') return null;
    const deadline = this.deadlines.get(approvalId);
    if (deadline === undefined || this.clock.monotonicNow() < deadline) {
      return null;
    }
    this.settle(
      record,
      'expired',
      'timeout',
      this.deny(record.toolUseID, DENIAL_MESSAGES.expired),
      'cancelled',
    );
    return this.store.getById(approvalId);
  }

  invalidateRun(runId: string, reason: 'run_cancelled' | 'sdk_aborted'): number {
    return this.invalidate(
      this.store.pendingForRun(runId),
      'invalidated',
      reason,
      DENIAL_MESSAGES.runCancelled,
      'cancelled',
    );
  }

  invalidateWorkspace(workspaceId: string, reason: 'policy_disabled'): number {
    return this.invalidate(
      this.store.pendingForWorkspace(workspaceId),
      'invalidated',
      reason,
      DENIAL_MESSAGES.policyDisabled,
      'denied',
    );
  }

  invalidateDevice(deviceId: string, reason: 'device_revoked'): number {
    return this.invalidate(
      this.store.pendingForDevice(deviceId),
      'invalidated',
      reason,
      DENIAL_MESSAGES.deviceRevoked,
      'denied',
    );
  }

  invalidateAll(reason: 'agent_shutdown'): number {
    return this.invalidate(
      this.store.allPending(),
      'invalidated',
      reason,
      DENIAL_MESSAGES.agentShutdown,
      'cancelled',
    );
  }

  private invalidate(
    records: readonly ApprovalRecord[],
    status: 'invalidated',
    reason: ResolutionReason,
    message: string,
    outcome: 'denied' | 'cancelled',
  ): number {
    let count = 0;
    for (const record of records) {
      try {
        const resolved = this.settle(
          record,
          status,
          reason,
          this.deny(record.toolUseID, message),
          outcome,
        );
        if (resolved !== null) count += 1;
      } catch {
        // settle 已在失败路径 deny 并降级；继续处理其余 pending。
      }
    }
    return count;
  }

  private expire(approvalId: string): void {
    const record = this.store.getById(approvalId);
    if (record === null || record.status !== 'pending') {
      this.clearTimer(approvalId);
      return;
    }
    try {
      this.settle(
        record,
        'expired',
        'timeout',
        this.deny(record.toolUseID, DENIAL_MESSAGES.expired),
        'cancelled',
      );
    } catch {
      // 失败路径已 deny 并降级。
    }
  }

  /** 终态：DB 事务失败时立即 deny，不悬挂 Promise。 */
  private settle(
    record: ApprovalRecord,
    status: Exclude<ApprovalStatus, 'pending'>,
    reason: ResolutionReason,
    result: PermissionResult,
    outcome: 'denied' | 'cancelled',
    responseCommandId: string | null = null,
  ): number | null {
    const resolvedAt = this.clock.wallNow();
    let committed: { previous: ApprovalRecord; current: ApprovalRecord } | null;
    try {
      committed = this.store.commitTerminal({
        approvalId: record.approvalId,
        status,
        resolutionReason: reason,
        resolvedAt,
        responseCommandId,
      });
    } catch {
      // allow 绝不能因存储失败生效；一律以 deny 结束并降级。
      this.dropAndDeny(
        record,
        this.deny(record.toolUseID, DENIAL_MESSAGES.storageUnavailable),
      );
      this.health.degraded('unavailable');
      throw new AgentError('STORAGE_UNAVAILABLE');
    }
    if (committed === null) return null;
    this.clearTimer(record.approvalId);
    this.store.clearVolatile(record.approvalId);
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
    resolver?.(result);
    return resolvedAt;
  }

  /** 策略/设备复核失败时复用同一终态路径；存储失败则直接 deny。 */
  private settleWithFailurePolicy(
    record: ApprovalRecord,
    status: 'invalidated',
    reason: ResolutionReason,
    result: PermissionResult,
    outcome: 'denied' | 'cancelled',
  ): void {
    try {
      this.settle(record, status, reason, result, outcome);
    } catch {
      // settle 已按失败策略处理。
    }
  }

  private dropAndDeny(record: ApprovalRecord, result: PermissionResult): void {
    this.clearTimer(record.approvalId);
    this.store.clearVolatile(record.approvalId);
    const resolver = this.resolvers.get(record.approvalId);
    this.resolvers.delete(record.approvalId);
    resolver?.(result);
    this.reportError(record, record.runId, 'STORAGE_UNAVAILABLE', DENIAL_MESSAGES.storageUnavailable);
  }

  private clearTimer(approvalId: string): void {
    this.deadlines.delete(approvalId);
    const cancel = this.cancelTimers.get(approvalId);
    if (cancel === undefined) return;
    cancel();
    this.cancelTimers.delete(approvalId);
  }

  private reportError(
    record: { sessionId: string },
    runId: string,
    code: string,
    message: string,
  ): void {
    this.events.reportError({
      code,
      message,
      sessionId: record.sessionId,
      runId,
    });
  }

  private deny(toolUseID: string, message: string): PermissionResult {
    return { behavior: 'deny', message, interrupt: false, toolUseID };
  }
}

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