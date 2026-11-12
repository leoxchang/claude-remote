import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanTree } from './check-secrets.js';

/** 门禁台账中的稳定状态。 */
export type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';

/** S02 必须全部 PASS 的 12 条真机用例。 */
export const E2E_IDS: readonly string[] = Array.from(
  { length: 12 },
  (_, index) => `E2E-${String(index + 1).padStart(2, '0')}`,
);

/** 门禁输入；任何一项不满足都失败。 */
export interface GateReport {
  mocks: GateStatus;
  conc01: GateStatus;
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

/** 汇总所有失败项；Mock 或 CONC-01 不能替代真机结论。 */
export function evaluateGate(report: GateReport): GateResult {
  const problems: string[] = [];
  if (report.mocks !== 'PASS') problems.push(`mocks are ${report.mocks}`);
  if (report.conc01 !== 'PASS') problems.push(`CONC-01 is ${report.conc01}`);
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

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function main(): void {
  const checklist = parseChecklist(
    readIfExists(join(REPO_ROOT, 'docs/s02/e2e-checklist.md')),
  );
  const secrets = [
    ...scanTree(join(REPO_ROOT, 'apps')),
    ...scanTree(join(REPO_ROOT, 'scripts')),
    ...scanTree(join(REPO_ROOT, 'protocol')),
    ...scanTree(join(REPO_ROOT, 'docs/s02')),
  ].map((finding) => `${finding.file}:${finding.line}:${finding.kind}`);
  const result = evaluateGate({
    mocks: 'PASS',
    conc01: 'PASS',
    e2e: checklist,
    realDevice: /realDevice:\s*true/i.test(
      readIfExists(join(REPO_ROOT, 'docs/s02/e2e-checklist.md')),
    ),
    rollbackDocumented: /##\s*回滚步骤/.test(
      readIfExists(join(REPO_ROOT, 'docs/s02/rollback.md')),
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

  const lines = [result.passed ? 'S02 Gate: PASS' : 'S02 Gate: FAIL'];
  for (const problem of result.problems) lines.push(`- ${problem}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}