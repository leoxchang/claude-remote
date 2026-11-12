import { describe, expect, it } from 'vitest';

import { scanText } from '../check-secrets.js';

describe('scanText', () => {
  it('detects an Anthropic API key', () => {
    const findings = scanText(
      'config.ts',
      'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('anthropic-key');
    expect(findings[0]?.line).toBe(1);
  });

  it('detects a bearer token and a private key block', () => {
    const text = [
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      '-----BEGIN RSA PRIVATE KEY-----',
    ].join('\n');

    const kinds = scanText('server.ts', text).map((finding) => finding.kind);

    expect(kinds).toContain('bearer-token');
    expect(kinds).toContain('private-key');
  });

  it('ignores short placeholders and unrelated text', () => {
    const text = [
      'Authorization: Bearer short',
      'token_DO_NOT_LEAK_99',
      'the word Bearer appears here',
    ].join('\n');

    expect(scanText('README.md', text)).toEqual([]);
  });

  it('does not echo the matched secret in the finding', () => {
    const findings = scanText(
      'x.ts',
      'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";',
    );
    expect(JSON.stringify(findings)).not.toContain('sk-ant-api03');
  });
});