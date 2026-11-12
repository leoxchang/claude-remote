import { describe, expect, it } from 'vitest';

import { checkSecrets, scanText } from '../check-secrets.js';

describe('checkSecrets', () => {
  it('rejects queued prompt text and real absolute paths', () => {
    expect(() =>
      checkSecrets('queued prompt text=/private/root/token=secret'),
    ).toThrow('SECRET_DETECTED');
    expect(() => checkSecrets('/private/var/folders/project')).toThrow(
      'SECRET_DETECTED',
    );
  });

  it('rejects credentials and private keys', () => {
    expect(() => checkSecrets(`key=${'sk-ant-'}${'a'.repeat(24)}`)).toThrow(
      'SECRET_DETECTED',
    );
    expect(() =>
      checkSecrets('-----BEGIN PRIVATE KEY-----'),
    ).toThrow('SECRET_DETECTED');
  });

  it('accepts ordinary text and test-style paths', () => {
    expect(() =>
      checkSecrets('workspaceId=ws_alpha sessionId=session_1 text=hello'),
    ).not.toThrow();
    expect(() => checkSecrets('/tmp/fixture-a')).not.toThrow();
  });

  it('never echoes the matching content', () => {
    const secret = `sk-ant-${'b'.repeat(32)}`;
    const findings = scanText('file.ts', secret);
    expect(findings).toHaveLength(1);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });
});