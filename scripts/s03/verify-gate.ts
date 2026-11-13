import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanTree } from './check-secrets.js';

/** 门禁台账中的稳定状态。 */
export type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';

/** 真实 SDK 证据标记；Mock 不能替代。 */
export type SdkEvidence = 'REAL' | 'MOCK' | 'MISSING';

/** S03 必须全部 PASS 的 12 条真机用例。 */
export const E2E_IDS: readonly string[] = Array.from(
  { length: 12 },
  (_, index) => `E2E-${String(index + 1).padStart(2, '0')}`,
);

/** 门禁输入；任何一项不满足都失败。 */
export interface GateReport {
  perm00: GateStatus;
  sdkEvidence: SdkEvidence;
  s02Gate: GateStatus;
  e2e: ReadonlyMap<string, GateStatus>;
  realDevice: boolean;
  rollbackDocumented: boolean;
  agentCoverage: number;
  dartCoverage: number;
  funnelEnabled: boolean;
  secrets: readonly string[];
}

export interface GateResult {
  passed: boolean;
  problems: string[];
}

/** 汇总所有失败项；Mock 或缺失真机证据不能替代真实结论。 */
export function evaluateGate(report: GateReport): GateResult {
  const problems: string[] = [];
  if (report.perm00 !== 'PASS') problems.push(`PERM-00 is ${report.perm00}`);
  if (report.sdkEvidence === 'MOCK') {
    problems.push('mock-only SDK evidence cannot pass; real SDK evidence is required');
  } else if (report.sdkEvidence !== 'REAL') {
    problems.push('real SDK evidence is missing');
  }
  if (report.s02Gate !== 'PASS') problems.push(`S02 gate is ${report.s02Gate}`);
  for (const id of E2E_IDS) {
    const status = report.e2e.get(id);
    if (status === undefined) {
      problems.push(`${id} missing from checklist`);
      continue;
    }
    if (status !== 'PASS') problems.push(`${id} is ${status}`);
  }
  if (!report.realDevice) problems.push('real device evidence is missing');
  if (!report.rollbackDocumented) problems.push('rollback steps are missing');
  if (report.agentCoverage < 80) {
    problems.push(`agent coverage ${report.agentCoverage}% < 80%`);
  }
  if (report.dartCoverage < 80) {
    problems.push(`dart coverage ${report.dartCoverage}% < 80%`);
  }
  if (report.funnelEnabled) problems.push('Tailscale Funnel must stay disabled');
  if (report.secrets.length > 0) {
    problems.push(`secrets found: ${report.secrets.join(', ')}`);
  }
  return { passed: problems.length === 0, problems };
}

/** 失败时抛出包含全部问题的错误。 */
export function verifyGate(report: GateReport): void {
  const result = evaluateGate(report);
  if (!result.passed) throw new Error(result.problems.join('; '));
}

/** 从 markdown 表格解析 `| E2E-xx | 场景 | 状态 | 证据 |`。 */
export function parseChecklist(markdown: string): Map<string, GateStatus> {
  const statuses = new Map<string, GateStatus>();
  for (const raw of markdown.split('\n')) {
    const match = /^\|\s*(E2E-\d{2})\s*\|([^|]*)\|([^|]*)\|/.exec(raw.trim());
    if (match === null) continue;
    const id = match[1];
    const status = match[3]?.trim();
    if (id === undefined || status === undefined) continue;
    statuses.set(id, status as GateStatus);
  }
  return statuses;
}

/** 从 lcov 计算行覆盖率；文件不存在返回 0。 */
export function lineCoverageFromLcov(path: string): number {
  let found = 0;
  let hit = 0;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 0;
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('DA:')) continue;
    const [, data] = line.split(':');
    if (data === undefined) continue;
    const [, count] = data.split(',');
    found += 1;
    if (Number(count) > 0) hit += 1;
  }
  return found === 0 ? 0 : Math.round((hit / found) * 1000) / 10;
}

/** Funnel 证据必须显式写着 false。 */
export function isFunnelDisabled(markdown: string): boolean {
  return /funnelEnabled:\s*false/i.test(markdown);
}

/** 真实 SDK 证据必须同时标出 REAL 且 PERM-00 PASS；允许 Markdown 加粗标记。 */
export function hasRealSdkEvidence(markdown: string): boolean {
  return (
    /sdkEvidence:\s*\**\s*REAL/i.test(markdown) &&
    /PERM-00:?\**\s*PASS/i.test(markdown)
  );
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function s02GateStatus(): GateStatus {
  const checklist = readIfExists(join(REPO_ROOT, 'docs/s02/e2e-checklist.md'));
  const statuses = parseChecklist(checklist);
  const allPass =
    statuses.size === E2E_IDS.length &&
    E2E_IDS.every((id) => statuses.get(id) === 'PASS');
  const realDevice = /realDevice:\s*true/i.test(checklist);
  const conc01 = /\bPASS\b/.test(
    readIfExists(join(REPO_ROOT, 'docs/s02/concurrency-evidence.md')),
  );
  return allPass && realDevice && conc01 ? 'PASS' : 'FAIL';
}

function main(): void {
  const checklist = readIfExists(join(REPO_ROOT, 'docs/s03/e2e-checklist.md'));
  const perm00 = readIfExists(join(REPO_ROOT, 'docs/s03/perm00-evidence.md'));
  const secrets = [
    ...scanTree(join(REPO_ROOT, 'apps')),
    ...scanTree(join(REPO_ROOT, 'scripts')),
    ...scanTree(join(REPO_ROOT, 'protocol')),
    ...scanTree(join(REPO_ROOT, 'docs/s03')),
  ].map((finding) => `${finding.file}:${finding.line}:${finding.kind}`);
  const result = evaluateGate({
    perm00: /结论：[\s*]*PASS/i.test(perm00) ? 'PASS' : 'FAIL',
    sdkEvidence: hasRealSdkEvidence(checklist)
      ? 'REAL'
      : /sdkEvidence:\s*MOCK/i.test(checklist)
        ? 'MOCK'
        : 'MISSING',
    s02Gate: s02GateStatus(),
    e2e: parseChecklist(checklist),
    realDevice: /realDevice:\s*true/i.test(checklist),
    rollbackDocumented: /##\s*回滚步骤/.test(
      readIfExists(join(REPO_ROOT, 'docs/s03/rollback.md')),
    ),
    agentCoverage: lineCoverageFromLcov(
      join(REPO_ROOT, 'apps/agent/coverage/lcov.info'),
    ),
    dartCoverage: lineCoverageFromLcov(
      join(REPO_ROOT, 'apps/mobile/coverage/lcov.info'),
    ),
    funnelEnabled: !isFunnelDisabled(
      readIfExists(join(REPO_ROOT, 'docs/s01/tailscale-setup.md')),
    ),
    secrets,
  });

  const lines = [result.passed ? 'S03 Gate: PASS' : 'S03 Gate: FAIL'];
  for (const problem of result.problems) lines.push(`- ${problem}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}