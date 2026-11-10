import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EvidenceRecord } from './evidence.js';
import {
  evaluateS00Gate,
  findEvidenceProblems,
  recordsFromStatus,
} from './gate.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STATUS_FILE = join(REPO_ROOT, 'docs/s00/status.json');

function main(): void {
  const raw: unknown = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  const records = recordsFromStatus(raw);
  const result = evaluateS00Gate(records);
  const problems = findEvidenceProblems(records, loadEvidence);

  const lines = [
    `S00 Core: ${result.core}`,
    `ASR Contract: ${result.asrContract}`,
    `ASR Live: ${result.asrLive}`,
  ];
  if (result.missingCoreIds.length > 0) {
    lines.push(`Missing Core: ${result.missingCoreIds.join(', ')}`);
  }
  if (result.limitedCoreIds.length > 0) {
    lines.push(`Limited Core: ${result.limitedCoreIds.join(', ')}`);
  }
  if (problems.length > 0) {
    lines.push(`Evidence problems: ${problems.join('; ')}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  const passed =
    result.core === 'PASS' &&
    result.asrContract === 'PASS' &&
    result.asrLive !== 'FAIL' &&
    problems.length === 0;
  process.exit(passed ? 0 : 1);
}

function loadEvidence(relativePath: string): EvidenceRecord | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, relativePath), 'utf8'),
    );
    if (typeof raw !== 'object' || raw === null) return undefined;
    const [record] = recordsFromStatus({ stored: raw });
    return record;
  } catch {
    return undefined;
  }
}

main();