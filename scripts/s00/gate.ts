import { EvidenceRecord, EvidenceStatus } from './evidence.js';

/** S00 Core 必须全部 PASS 的测试 ID。 */
export const CORE_IDS: readonly string[] = [
  ...sequence('SDK', 12),
  ...sequence('CLI', 3),
  ...sequence('PROTO', 11),
];

/** ASR fake 契约必须全部 PASS 的测试 ID。 */
export const ASR_CONTRACT_IDS: readonly string[] = sequence('ASR', 8);

/** 真实豆包联调记录 ID（延迟门禁）。 */
export const ASR_LIVE_ID = 'DOUBAO-LIVE';

const VALID_STATUSES: readonly EvidenceStatus[] = [
  'PASS',
  'FAIL',
  'BLOCKED',
  'NOT_RUN',
  'LIMITED',
];

export type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED';
export type AsrLiveStatus = 'PASS' | 'FAIL' | 'DEFERRED';

export interface S00GateResult {
  core: GateStatus;
  asrContract: GateStatus;
  asrLive: AsrLiveStatus;
  missingCoreIds: string[];
  limitedCoreIds: string[];
}

/** 按固定 ID 集合评估 S00 退出门禁；缺失、NOT_RUN、BLOCKED、LIMITED 都不算通过。 */
export function evaluateS00Gate(
  records: readonly EvidenceRecord[],
): S00GateResult {
  const byId = new Map(records.map((record) => [record.id, record]));
  const core = evaluateGroup(CORE_IDS, byId);
  const asrContract = evaluateGroup(ASR_CONTRACT_IDS, byId);

  return {
    core: core.status,
    asrContract: asrContract.status,
    asrLive: evaluateAsrLive(byId.get(ASR_LIVE_ID)),
    missingCoreIds: core.missingIds,
    limitedCoreIds: core.limitedIds,
  };
}

/** 把 docs/s00/status.json 转成证据记录；保留 DOUBAO-LIVE 的 deferredTo。 */
export function recordsFromStatus(status: unknown): EvidenceRecord[] {
  if (typeof status !== 'object' || status === null) {
    throw new Error('status ledger must be a JSON object');
  }

  const records: EvidenceRecord[] = [];
  for (const [id, rawEntry] of Object.entries(
    status as Record<string, unknown>,
  )) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      throw new Error(`status ledger entry ${id} must be an object`);
    }
    const entry = rawEntry as Record<string, unknown>;
    const entryStatus = entry['status'];
    if (
      typeof entryStatus !== 'string' ||
      !VALID_STATUSES.includes(entryStatus as EvidenceStatus)
    ) {
      throw new Error(`status ledger entry ${id} has an invalid status`);
    }

    records.push({
      id,
      status: entryStatus as EvidenceStatus,
      summary: typeof entry['summary'] === 'string' ? entry['summary'] : '',
      observedAt:
        typeof entry['observedAt'] === 'string' ? entry['observedAt'] : null,
      ...(typeof entry['evidence'] === 'string'
        ? { evidence: entry['evidence'] }
        : {}),
      ...(entry['deferredTo'] === 'S05'
        ? { deferredTo: 'S05' as const }
        : {}),
    });
  }
  return records;
}

interface GroupEvaluation {
  status: GateStatus;
  missingIds: string[];
  limitedIds: string[];
}

function evaluateGroup(
  ids: readonly string[],
  byId: ReadonlyMap<string, EvidenceRecord>,
): GroupEvaluation {
  const missingIds: string[] = [];
  const limitedIds: string[] = [];
  let failed = false;
  let notPassed = false;

  for (const id of ids) {
    const record = byId.get(id);
    if (record === undefined) {
      missingIds.push(id);
      continue;
    }
    if (record.status === 'FAIL') failed = true;
    if (record.status === 'LIMITED') limitedIds.push(id);
    if (record.status !== 'PASS') notPassed = true;
  }

  const status: GateStatus =
    failed ? 'FAIL' : missingIds.length > 0 || notPassed ? 'BLOCKED' : 'PASS';
  return { status, missingIds, limitedIds };
}

function evaluateAsrLive(record: EvidenceRecord | undefined): AsrLiveStatus {
  if (record === undefined) return 'DEFERRED';
  if (record.status === 'PASS') return 'PASS';
  if (record.status === 'FAIL') return 'FAIL';
  if (record.status === 'NOT_RUN' && record.deferredTo === 'S05') {
    return 'DEFERRED';
  }
  return 'FAIL';
}

function sequence(prefix: string, count: number): string[] {
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    ids.push(`${prefix}-${String(index).padStart(2, '0')}`);
  }
  return ids;
}