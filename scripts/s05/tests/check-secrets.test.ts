import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanDoubaoText, scanEvidenceTree } from '../check-secrets.js';

describe('S05 secret scanner', () => {
  it('flags Doubao environment values and header values', () => {
    const findings = scanDoubaoText(
      'input',
      [
        'DOUBAO_ASR_API_KEY=abcdef123456',
        'X-Api-Key: abcdef123456',
        'Authorization: Bearer abcdefghijklmnopqrstuvwx',
      ].join('\n'),
    );
    expect(findings.map((finding) => finding.kind)).toEqual(
      expect.arrayContaining([
        'authorization-header',
        'doubao-api-header',
        'doubao-env-value',
      ]),
    );
  });

  it('does not flag bare environment variable names', () => {
    expect(
      scanDoubaoText('input', "env['DOUBAO_ASR_API_KEY']"),
    ).toEqual([]);
  });

  it('flags raw audio in evidence directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 's05-evidence-'));
    writeFileSync(join(dir, 'sample.pcm'), '');
    const findings = scanEvidenceTree(dir);
    expect(findings.map((finding) => finding.kind)).toEqual(['raw-audio']);
  });

  it('flags secrets inside evidence markdown', () => {
    const dir = mkdtempSync(join(tmpdir(), 's05-evidence-'));
    writeFileSync(join(dir, 'report.md'), 'DOUBAO_ASR_API_KEY=secret123456\n');
    const findings = scanEvidenceTree(dir);
    expect(findings.map((finding) => finding.kind)).toEqual([
      'doubao-env-value',
    ]);
  });
});