import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanTree } from '../s03/check-secrets.js';

/** S04 门禁状态。 */
export type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
export type SdkEvidence = 'REAL' | 'MOCK' | 'MISSING';

export const E2E_IDS: readonly string[] = Array.from(
  { length: 15 },
  (_, index) => `E2E-${String(index + 1).padStart(2, '0')}`,
);

export interface GateReport {
  store00Mac: GateStatus;
  store00Iphone: GateStatus;
  realDataProtection: boolean;
  sdkEvidence: SdkEvidence;
  e2e: ReadonlyMap<string, GateStatus>;
  agentCoverage: number;
  dartCoverage: number;
  funnelEnabled: boolean;
  secrets: readonly string[];
}

export interface GateResult {
  passed: boolean;
  problems: string[];
}

/** 汇总全部失败项；Mock、缺真机或未通过 STORE-00 均不能放行。 */
export function evaluateGate(report: GateReport): GateResult {
  const problems: string[] = [];
  if (report.store00Mac !== 'PASS') problems.push(`STORE-00 Mac is ${report.store00Mac}`);
  if (report.store00Iphone !== 'PASS') {
    problems.push(`STORE-00 iPhone is ${report.store00Iphone}`);
  }
  if (!report.realDataProtection) {
    problems.push('iPhone Data Protection evidence is missing');
  }
  if (report.sdkEvidence === 'MOCK') {
    problems.push('mock-only SDK evidence cannot pass; real SDK evidence is required');
  } else if (report.sdkEvidence !== 'REAL') {
    problems.push('real SDK evidence is missing');
  }
  for (const id of E2E_IDS) {
    const status = report.e2e.get(id);
    if (status === undefined) {
      problems.push(`${id} missing from checklist`);
      continue;
    }
    if (status !== 'PASS') problems.push(`${id} is ${status}`);
  }
  if (report.agentCoverage < 80) problems.push(`agent coverage ${report.agentCoverage}% < 80%`);
  if (report.dartCoverage < 80) problems.push(`dart coverage ${report.dartCoverage}% < 80%`);
  if (report.funnelEnabled) problems.push('Tailscale Funnel must stay disabled');
  if (report.secrets.length > 0) problems.push(`secrets found: ${report.secrets.join(', ')}`);
  return { passed: problems.length === 0, problems };
}

export function verifyGate(report: GateReport): void {
  const result = evaluateGate(report);
  if (!result.passed) throw new Error(result.problems.join('; '));
}

/** 解析 `| E2E-xx | 场景 | 状态 | 证据 |`。 */
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

/** 从 evidence 读取 STORE-00 结果。 */
export function readStore00(markdown: string): {
  mac: GateStatus;
  iphone: GateStatus;
  dataProtection: boolean;
} {
  const mac = /STORE-00 Mac[^\n]*PASS/i.test(markdown)
    ? 'PASS'
    : 'NOT_RUN';
  const iphone = /IPHONE:\s*PASS/i.test(markdown) ? 'PASS' : 'BLOCKED';
  return {
    mac,
    iphone,
    dataProtection: /dataProtection:\s*true/i.test(markdown),
  };
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

export function isFunnelDisabled(markdown: string): boolean {
  return /funnelEnabled:\s*false/i.test(markdown);
}

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

function main(): void {
  const checklist = readIfExists(join(REPO_ROOT, 'docs/s04/e2e-checklist.md'));
  const store00 = readStore00(readIfExists(join(REPO_ROOT, 'docs/s04/store00-evidence.md')));
  const secrets = [
    ...scanTree(join(REPO_ROOT, 'apps')),
    ...scanTree(join(REPO_ROOT, 'scripts')),
    ...scanTree(join(REPO_ROOT, 'protocol')),
    ...scanTree(join(REPO_ROOT, 'docs/s04')),
  ].map((finding) => `${finding.file}:${finding.line}:${finding.kind}`);
  const result = evaluateGate({
    store00Mac: store00.mac,
    store00Iphone: store00.iphone,
    realDataProtection: store00.dataProtection,
    sdkEvidence: hasRealSdkEvidence(checklist) ? 'REAL' : 'MISSING',
    e2e: parseChecklist(checklist),
    agentCoverage: lineCoverageFromLcov(join(REPO_ROOT, 'apps/agent/coverage/lcov.info')),
    dartCoverage: lineCoverageFromLcov(join(REPO_ROOT, 'apps/mobile/coverage/lcov.info')),
    funnelEnabled: !isFunnelDisabled(readIfExists(join(REPO_ROOT, 'docs/s01/tailscale-setup.md'))),
    secrets,
  });
  const lines = [result.passed ? 'S04 Gate: PASS' : 'S04 Gate: FAIL'];
  for (const problem of result.problems) lines.push(`- ${problem}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}