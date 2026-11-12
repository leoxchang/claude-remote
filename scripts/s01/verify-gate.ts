import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanTree, SecretFinding } from './check-secrets.js';

/** E2E 台账中的稳定状态。 */
export type E2eStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';

/** S01 必须全部 PASS 的 12 条真机用例。 */
export const E2E_IDS: readonly string[] = Array.from(
  { length: 12 },
  (_, index) => `E2E-${String(index + 1).padStart(2, '0')}`,
);

/** 从 markdown 表格解析 `| E2E-xx | 场景 | 状态 | 证据 |`。 */
export function parseChecklist(markdown: string): Map<string, E2eStatus> {
  const statuses = new Map<string, E2eStatus>();
  for (const raw of markdown.split('\n')) {
    const match = /^\|\s*(E2E-\d{2})\s*\|([^|]*)\|([^|]*)\|/.exec(raw.trim());
    if (match === null) continue;
    const id = match[1];
    const status = match[3]?.trim();
    if (id === undefined || status === undefined) continue;
    statuses.set(id, status as E2eStatus);
  }
  return statuses;
}

export interface GateInput {
  checklist: Map<string, E2eStatus>;
  secrets: readonly SecretFinding[];
  funnelEnabled: boolean;
  agentCoverage: number;
  dartCoverage: number;
}

export interface GateResult {
  passed: boolean;
  problems: string[];
}

/** 任何缺失、非 PASS、secret、Funnel 或覆盖率不足都会让门禁失败。 */
export function evaluateGate(input: GateInput): GateResult {
  const problems: string[] = [];
  for (const id of E2E_IDS) {
    const status = input.checklist.get(id);
    if (status === undefined) {
      problems.push(`${id} missing from checklist`);
      continue;
    }
    if (status !== 'PASS') problems.push(`${id} is ${status}`);
  }
  if (input.secrets.length > 0) {
    const summary = input.secrets
      .map((finding) => `${finding.file}:${finding.line}:${finding.kind}`)
      .join(', ');
    problems.push(`secrets found: ${summary}`);
  }
  if (input.funnelEnabled) problems.push('Tailscale Funnel must stay disabled');
  if (input.agentCoverage < 80) {
    problems.push(`agent coverage ${input.agentCoverage}% < 80%`);
  }
  if (input.dartCoverage < 80) {
    problems.push(`dart coverage ${input.dartCoverage}% < 80%`);
  }
  return { passed: problems.length === 0, problems };
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
    readIfExists(join(REPO_ROOT, 'docs/s01/e2e-checklist.md')),
  );
  const result = evaluateGate({
    checklist,
    secrets: scanTree(join(REPO_ROOT, 'apps')) .concat(
      scanTree(join(REPO_ROOT, 'scripts')),
      scanTree(join(REPO_ROOT, 'protocol')),
      scanTree(join(REPO_ROOT, 'docs')),
    ),
    funnelEnabled: !isFunnelDisabled(
      readIfExists(join(REPO_ROOT, 'docs/s01/tailscale-setup.md')),
    ),
    agentCoverage: lineCoverageFromLcov(
      join(REPO_ROOT, 'apps/agent/coverage/lcov.info'),
    ),
    dartCoverage: lineCoverageFromLcov(
      join(REPO_ROOT, 'apps/mobile/coverage/lcov.info'),
    ),
  });

  const lines = [result.passed ? 'S01 Gate: PASS' : 'S01 Gate: FAIL'];
  for (const problem of result.problems) lines.push(`- ${problem}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}