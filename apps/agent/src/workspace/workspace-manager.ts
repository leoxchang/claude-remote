import { AgentError } from '../command/errors.js';
import {
  AgentConfigV3,
  isMobileApprovalMode,
  writeConfigV3AtomicSync,
} from '../config/config-v3.js';
import { ConfigV2Error, validateDisplayName } from '../config/config-v2.js';
import {
  assertWorkspacePathCurrent,
  resolveWorkspacePath,
} from '../config/workspace-path.js';
import { randomBase64Url } from '../security/random.js';
import {
  DEFAULT_MOBILE_APPROVAL_MODE,
  DEFAULT_PER_SESSION_QUEUE_LIMIT,
  MAX_WORKSPACES,
  MobileApprovalMode,
  toSummary,
  WorkspaceRecord,
  WorkspaceSummary,
} from './workspace-types.js';

const WORKSPACE_ID_BYTES = 9;

/** 运行期使用检查；Task 9 由 RunScheduler 实现。 */
export interface WorkspaceUsage {
  hasActiveOrQueued(workspaceId: string): boolean;
}

/** 项目管理依赖；写盘、usage 与策略回调可注入以便测试。 */
export interface WorkspaceManagerOptions {
  configDir: string;
  config: AgentConfigV3;
  usage?: WorkspaceUsage;
  writeConfig?: (configDir: string, config: AgentConfigV3) => void;
  /** 内存快照替换后同步调用；用于失效该项目的 pending 审批。 */
  onApprovalModeChanged?: (
    workspaceId: string,
    mode: MobileApprovalMode,
  ) => void;
}

/**
 * 本机项目授权管理。
 *
 * 变更顺序固定为「校验 → 同步写盘 → 替换内存快照」，
 * 写盘失败时不改变内存状态，移除不删除任何项目文件。
 */
export class WorkspaceManager {
  private config: AgentConfigV3;
  private readonly removed = new Set<string>();
  private readonly usage: WorkspaceUsage;
  private readonly writeConfig: (
    configDir: string,
    config: AgentConfigV3,
  ) => void;

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.config = options.config;
    this.usage = options.usage ?? { hasActiveOrQueued: () => false };
    this.writeConfig = options.writeConfig ?? writeConfigV3AtomicSync;
  }

  /** 添加项目；保存解析后的真实路径。 */
  async add(input: {
    path: string;
    displayName: string;
  }): Promise<WorkspaceRecord> {
    const displayName = validateDisplayName(input.displayName);
    const rootPath = await resolveWorkspacePath(input.path);
    const current = this.config.workspaces;
    if (current.length >= MAX_WORKSPACES) {
      throw new ConfigV2Error('TOO_MANY_WORKSPACES');
    }
    if (current.some((workspace) => workspace.rootPath === rootPath)) {
      throw new AgentError('INVALID_MESSAGE');
    }
    const record: WorkspaceRecord = {
      workspaceId: `ws_${randomBase64Url(WORKSPACE_ID_BYTES)}`,
      displayName,
      rootPath,
      createdAt: Date.now(),
      policy: {
        perSessionQueueLimit: DEFAULT_PER_SESSION_QUEUE_LIMIT,
        mobileApprovalMode: DEFAULT_MOBILE_APPROVAL_MODE,
      },
    };
    this.commit([...current, record]);
    this.removed.delete(record.workspaceId);
    return { ...record, policy: { ...record.policy } };
  }

  /** 当前全部项目摘要；不含真实路径。 */
  list(): WorkspaceSummary[] {
    return this.config.workspaces.map(toSummary);
  }

  /** 只改显示名；ID、路径与运行中 run 不变。 */
  async rename(workspaceId: string, displayName: string): Promise<WorkspaceSummary> {
    const record = this.find(workspaceId);
    const next = validateDisplayName(displayName);
    const updated = { ...record, displayName: next };
    this.commit(
      this.config.workspaces.map((workspace) =>
        workspace.workspaceId === workspaceId ? updated : workspace,
      ),
    );
    return toSummary(updated);
  }

  /** 移除授权；有活跃或 queued run 时拒绝，不删除项目文件。 */
  async remove(workspaceId: string): Promise<void> {
    const record = this.find(workspaceId);
    if (this.usage.hasActiveOrQueued(record.workspaceId)) {
      throw new AgentError('WORKSPACE_BUSY');
    }
    this.commit(
      this.config.workspaces.filter(
        (workspace) => workspace.workspaceId !== workspaceId,
      ),
    );
    this.removed.add(workspaceId);
  }

  /**
   * 逐项目开启或关闭手机审批。
   *
   * 校验、同步写盘、替换内存快照与策略监听回调都在同一调用栈完成；
   * 写盘失败时不改变内存状态。
   */
  setApprovalMode(
    workspaceId: string,
    mode: MobileApprovalMode,
  ): WorkspaceSummary {
    if (!isMobileApprovalMode(mode)) {
      throw new AgentError('INVALID_MESSAGE');
    }
    const record = this.find(workspaceId);
    if (record.policy.mobileApprovalMode === mode) {
      return toSummary(record);
    }
    const updated: WorkspaceRecord = {
      ...record,
      policy: { ...record.policy, mobileApprovalMode: mode },
    };
    this.commit(
      this.config.workspaces.map((workspace) =>
        workspace.workspaceId === workspaceId ? updated : workspace,
      ),
    );
    this.options.onApprovalModeChanged?.(workspaceId, mode);
    return toSummary(updated);
  }

  /** 当前项目的审批模式；未知 ID 报 WORKSPACE_NOT_FOUND。 */
  approvalMode(workspaceId: string): MobileApprovalMode {
    return this.find(workspaceId).policy.mobileApprovalMode;
  }

  /**
   * 启动 run 前的同步复核。
   *
   * 未知 ID 与已移除 ID 分开报错，路径被删或改指时报 WORKSPACE_NOT_ALLOWED。
   */
  assertUsable(workspaceId: string): WorkspaceRecord {
    const record = this.config.workspaces.find(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    if (record === undefined) {
      if (this.removed.has(workspaceId)) throw new AgentError('WORKSPACE_NOT_ALLOWED');
      throw new AgentError('WORKSPACE_NOT_FOUND');
    }
    assertWorkspacePathCurrent(record);
    return { ...record, policy: { ...record.policy } };
  }

  private find(workspaceId: string): WorkspaceRecord {
    const record = this.config.workspaces.find(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    if (record === undefined) throw new AgentError('WORKSPACE_NOT_FOUND');
    return record;
  }

  /** 先同步写盘，成功后才替换内存快照。 */
  private commit(workspaces: WorkspaceRecord[]): void {
    const next: AgentConfigV3 = { ...this.config, workspaces };
    this.writeConfig(this.options.configDir, next);
    this.config = next;
  }
}