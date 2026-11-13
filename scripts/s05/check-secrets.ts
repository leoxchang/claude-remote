/**
 * S05 密钥/音频扫描：复用 S03 规则并补充豆包专用模式。
 *
 * 命中只记录文件、行号与类别，不打印命中内容。
 */
import { Dirent, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SecretFinding, scanText } from '../s03/check-secrets.js';

export { checkSecrets, scanText, scanTree } from '../s03/check-secrets.js';
export type { SecretFinding } from '../s03/check-secrets.js';

const DOUBAO_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'doubao-env-value', pattern: /DOUBAO_ASR_API_KEY\s*=\s*\S+/ },
  { kind: 'doubao-api-header', pattern: /X-Api-Key\s*:\s*\S{8,}/ },
  {
    kind: 'authorization-header',
    pattern: /Authorization\s*:\s*['"]?Bearer\s+\S{20,}/,
  },
];

/** 扫描一段文本中的豆包专用泄漏。 */
export function scanDoubaoText(file: string, text: string): SecretFinding[] {
  const findings = scanText(file, text);
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const { kind, pattern } of DOUBAO_PATTERNS) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, kind });
    }
  }
  return findings;
}

/** 证据目录不得包含任何原始音频文件。 */
export function scanEvidenceTree(root: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const walk = (directory: string): void => {
    const entries = listDirectory(directory);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.(?:pcm|wav|aiff)$/i.test(entry.name)) {
        findings.push({ file: path, line: 0, kind: 'raw-audio' });
        continue;
      }
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      findings.push(...scanDoubaoText(path, text));
    }
  };
  walk(root);
  return findings;
}

function listDirectory(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}