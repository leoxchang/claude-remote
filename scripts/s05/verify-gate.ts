/**
 * S05 退出门禁：只读脱敏证据与固定路径，不访问真实 Key。
 *
 * 任何 ASR-00/E2E 缺口、覆盖率不足、密钥/音频泄漏、Funnel 开启或
 * ASR 事件污染主状态都会以非零退出。
 */
import { Dirent, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanTree } from '../s03/check-secrets.js';
import { scanEvidenceTree } from './check-secrets.js';

/** 门禁状态。 */
export type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';

export const E2E_IDS: readonly string[] = Array.from(
  { length: 14 },
  (_, index) => `E2E-${String(index + 1).padStart(2, '0')}`,
);

export interface GateReport {
  asr00: GateStatus;
  e2e: ReadonlyMap<string, GateStatus>;
  agentCoverage: number;
  dartCoverage: number;
  funnelEnabled: boolean;
  secrets: readonly string[];
  appEnvLeak: boolean;
  audioEvidence: boolean;
  asrIsolationViolations: readonly string[];
}

export interface GateResult {
  passed: boolean;
  problems: string[];
}

/** 汇总全部缺口；模拟器或 fake 证据不能替代真实 ASR-00/E2E。 */
export function evaluateGate(report: GateReport): GateResult {
  const problems: string[] = [];
  if (report.asr00 !== 'PASS') problems.push(`ASR-00 is ${report.asr00}`);
  for (const id of E2E_IDS) {
    const status = report.e2e.get(id);
    if (status === undefined) {
      problems.push(`${id} missing from checklist`);
      continue;
    }
    if (status !== 'PASS') problems.push(`${id} is ${status}`);
  }
  if (report.agentCoverage < 80) {
    problems.push(`agent coverage ${report.agentCoverage}% < 80%`);
  }
  if (report.dartCoverage < 80) {
    problems.push(`dart coverage ${report.dartCoverage}% < 80%`);
  }
  if (report.funnelEnabled) {
    problems.push('Tailscale Funnel must stay disabled');
  }
  if (report.secrets.length > 0) {
    problems.push(`secrets found: ${report.secrets.join(', ')}`);
  }
  if (report.appEnvLeak) {
    problems.push('App contains Doubao environment variable names or X-Api-Key');
  }
  if (report.audioEvidence) {
    problems.push('evidence directory contains raw audio files');
  }
  for (const violation of report.asrIsolationViolations) {
    problems.push(`ASR isolation: ${violation}`);
  }
  return { passed: problems.length === 0, problems };
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

/** 读取 ASR-00 证据首行结论。 */
export function readAsr00(markdown: string): GateStatus {
  if (/ASR-00:?\s*\**\s*PASS/i.test(markdown)) return 'PASS';
  if (/ASR-00:?\s*\**\s*FAIL/i.test(markdown)) return 'FAIL';
  if (/BLOCKED/i.test(markdown)) return 'BLOCKED';
  return 'NOT_RUN';
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

/** App 不得包含豆包环境变量名或 X-Api-Key 头。 */
export function findAppEnvLeaks(files: ReadonlyMap<string, string>): string[] {
  const leaks: string[] = [];
  for (const [path, text] of files) {
    if (/DOUBAO_ASR_API_KEY|X-Api-Key/.test(text)) leaks.push(path);
  }
  return leaks;
}

/** ASR 不得依赖 Journal、SQLite、run 或审批模块。 */
export function findAsrIsolationViolations(
  files: ReadonlyMap<string, string>,
): string[] {
  const forbidden =
    /from '(?:\.\.\/)+(?:events|storage|run|approval|command)\//;
  const violations: string[] = [];
  for (const [path, text] of files) {
    if (forbidden.test(text)) violations.push(path);
  }
  return violations;
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** 收集目录下所有文本文件内容；缺失目录返回空。 */
export function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    const entries = listDirectory(directory);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(?:ts|dart|swift)$/.test(entry.name)) continue;
      files.set(path, readIfExists(path));
    }
  };
  walk(root);
  return files;
}

function listDirectory(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function main(): void {
  const checklist = readIfExists(join(REPO_ROOT, 'docs/s05/e2e-checklist.md'));
  const asr00 = readAsr00(
    readIfExists(join(REPO_ROOT, 'docs/s05/asr00-evidence.md')),
  );
  const appFiles = readTree(join(REPO_ROOT, 'apps/mobile/lib'));
  const asrFiles = readTree(join(REPO_ROOT, 'apps/agent/src/asr'));
  const secrets = [
    ...scanTree(join(REPO_ROOT, 'apps/agent/src/asr')),
    ...scanTree(join(REPO_ROOT, 'apps/mobile/lib')),
    ...scanTree(join(REPO_ROOT, 'protocol/v1/examples/s05')),
    ...scanEvidenceTree(join(REPO_ROOT, 'docs/s05')),
  ].map((finding) => `${finding.file}:${finding.line}:${finding.kind}`);
  const result = evaluateGate({
    asr00,
    e2e: parseChecklist(checklist),
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
    appEnvLeak: findAppEnvLeaks(appFiles).length > 0,
    audioEvidence: scanEvidenceTree(join(REPO_ROOT, 'docs/s05')).some(
      (finding) => finding.kind === 'raw-audio',
    ),
    asrIsolationViolations: findAsrIsolationViolations(asrFiles),
  });
  const lines = [result.passed ? 'S05 Gate: PASS' : 'S05 Gate: FAIL'];
  for (const problem of result.problems) lines.push(`- ${problem}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}