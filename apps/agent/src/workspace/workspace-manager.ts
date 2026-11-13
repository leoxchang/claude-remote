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
import { WorkspaceRepository } from '../storage/repositories/workspace-repository.js';

const WORKSPACE_ID_BYTES = 9;

/** 运行期使用检查；Task 9 由 RunScheduler 实现。 */
export interface WorkspaceUsage {
  hasActiveOrQueued(workspaceId: string): boolean;
}

/** 项目管理依赖；写盘、usage 与策略回调可注入以便测试。 */
export interface WorkspaceManagerOptions {
  configDir?: string;
  /** V3 文件存储路径仍在使用时的内存配置快照。 */
  config?: AgentConfigV3;
  /** V4 起以 SQLite 仓库为权威。 */
  repository?: WorkspaceRepository;
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
 * 变更顺序固定为「校验 → 同步写库 → 替换内存快照」，
 * 写入失败时不改变可见状态，移除不删除任何项目文件。
 */
export class WorkspaceManager {
  private readonly repository: WorkspaceRepository;
  private readonly usage: WorkspaceUsage;

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.usage = options.usage ?? { hasActiveOrQueued: () => false };
    this.repository = options.repository ?? legacyRepository(options);
  }

  /** 添加项目；保存解析后的真实路径。 */
  async add(input: {
    path: string;
    displayName: string;
  }): Promise<WorkspaceRecord> {
    const displayName = validateDisplayName(input.displayName);
    const rootPath = await resolveWorkspacePath(input.path);
    const current = this.repository.list();
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
    this.repository.insert(record);
    return { ...record, policy: { ...record.policy } };
  }

  /** 当前全部项目摘要；不含真实路径。 */
  list(): WorkspaceSummary[] {
    return this.repository.list().map(toSummary);
  }

  /** 只改显示名；ID、路径与运行中 run 不变。 */
  async rename(
    workspaceId: string,
    displayName: string,
  ): Promise<WorkspaceSummary> {
    const record = this.find(workspaceId);
    const next = validateDisplayName(displayName);
    const updated = { ...record, displayName: next };
    this.repository.update(updated);
    return toSummary(updated);
  }

  /** 移除授权；有活跃或 queued run 时拒绝，不删除项目文件。 */
  async remove(workspaceId: string): Promise<void> {
    const record = this.find(workspaceId);
    if (this.usage.hasActiveOrQueued(record.workspaceId)) {
      throw new AgentError('WORKSPACE_BUSY');
    }
    this.repository.remove(workspaceId, Date.now());
  }

  /**
   * 逐项目开启或关闭手机审批。
   *
   * 校验、同步写库与策略监听回调都在同一调用栈完成；
   * 写入失败时不改变内存状态。
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
    this.repository.update(updated);
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
    const record = this.repository.get(workspaceId);
    if (record === undefined) {
      if (this.repository.isRemoved(workspaceId)) {
        throw new AgentError('WORKSPACE_NOT_ALLOWED');
      }
      throw new AgentError('WORKSPACE_NOT_FOUND');
    }
    assertWorkspacePathCurrent(record);
    return { ...record, policy: { ...record.policy } };
  }

  private find(workspaceId: string): WorkspaceRecord {
    const record = this.repository.get(workspaceId);
    if (record === undefined) throw new AgentError('WORKSPACE_NOT_FOUND');
    return record;
  }
}

/** V3 JSON 适配器；写盘成功后才更新内存快照。 */
class V3ConfigWorkspaceRepository implements WorkspaceRepository {
  private readonly removed = new Set<string>();

  constructor(private readonly options: WorkspaceManagerOptions) {}

  list(): WorkspaceRecord[] {
    return this.config().workspaces;
  }

  get(workspaceId: string): WorkspaceRecord | undefined {
    return this.config().workspaces.find(
      (workspace) => workspace.workspaceId === workspaceId,
    );
  }

  isRemoved(workspaceId: string): boolean {
    return this.removed.has(workspaceId);
  }

  insert(record: WorkspaceRecord): void {
    this.commit([...(this.config().workspaces ?? []), record]);
    this.removed.delete(record.workspaceId);
  }

  update(record: WorkspaceRecord): void {
    this.commit(
      this.config().workspaces.map((workspace) =>
        workspace.workspaceId === record.workspaceId ? record : workspace,
      ),
    );
  }

  remove(workspaceId: string, _now: number): void {
    this.commit(
      this.config().workspaces.filter(
        (workspace) => workspace.workspaceId !== workspaceId,
      ),
    );
    this.removed.add(workspaceId);
  }

  private config(): AgentConfigV3 {
    const config = this.options.config;
    if (config === undefined) {
      throw new Error('workspace manager requires a repository or V3 config');
    }
    return config;
  }

  private commit(workspaces: WorkspaceRecord[]): void {
    const current = this.config();
    const next: AgentConfigV3 = { ...current, workspaces };
    const configDir = this.options.configDir;
    if (configDir === undefined) {
      throw new Error('workspace manager requires configDir');
    }
    (this.options.writeConfig ?? writeConfigV3AtomicSync)(configDir, next);
    this.options.config = next;
  }
}

function legacyRepository(
  options: WorkspaceManagerOptions,
): WorkspaceRepository {
  if (options.config === undefined) {
    throw new Error('workspace manager requires a repository or V3 config');
  }
  return new V3ConfigWorkspaceRepository(options);
}