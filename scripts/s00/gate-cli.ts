import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { evaluateS00Gate, recordsFromStatus } from './gate.js';

const STATUS_FILE = fileURLToPath(
  new URL('../../docs/s00/status.json', import.meta.url),
);

function main(): void {
  const raw: unknown = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  const result = evaluateS00Gate(recordsFromStatus(raw));

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
  process.stdout.write(`${lines.join('\n')}\n`);

  const passed =
    result.core === 'PASS' &&
    result.asrContract === 'PASS' &&
    result.asrLive !== 'FAIL';
  process.exit(passed ? 0 : 1);
}

main();