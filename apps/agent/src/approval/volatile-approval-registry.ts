import { JsonValue } from '../domain/types.js';
import {
  ApprovalContent,
  PermissionResult,
} from './approval-types.js';

/** pending 期间唯一允许保存正文的位置；终态或失败时立即清除。 */
export interface VolatileApprovalEntry {
  content: ApprovalContent;
  originalInput: Record<string, JsonValue>;
  resultPromise: Promise<PermissionResult>;
}

/** 内存正文索引；从不写库、不进入日志。 */
export class VolatileApprovalRegistry {
  private readonly entries = new Map<string, VolatileApprovalEntry>();

  register(approvalId: string, entry: VolatileApprovalEntry): void {
    this.entries.set(approvalId, entry);
  }

  get(approvalId: string): VolatileApprovalEntry | null {
    return this.entries.get(approvalId) ?? null;
  }

  remove(approvalId: string): void {
    this.entries.delete(approvalId);
  }

  clearAll(): void {
    this.entries.clear();
  }

  has(approvalId: string): boolean {
    return this.entries.has(approvalId);
  }

  size(): number {
    return this.entries.size;
  }
}