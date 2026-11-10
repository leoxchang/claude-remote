import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { redactEvidence, writeEvidence } from '../evidence.js';

const SENSITIVE_ENV_VALUE = 'ENV_SECRET_4C1D9';
const REDACTED_PLACEHOLDER = '[REDACTED]';

describe('redactEvidence', () => {
  it('redacts nested credential fields case-insensitively and keeps safe fields', () => {
    const input = {
      requestId: 'req-5e10',
      resourceId: 'resource-51a0',
      headers: {
        Authorization: 'Bearer bearer-7f3a',
        Cookie: 'session=cookie-91c2',
        'X-Request-Id': 'req-5e10',
      },
      auth: {
        accessToken: 'token-62bd',
        nested: { apiKey: 'key-4a91', resourceId: 'resource-51a0' },
      },
    };
    const before = JSON.stringify(input);

    const serialized = JSON.stringify(redactEvidence(input));

    expect(serialized).not.toContain('bearer-7f3a');
    expect(serialized).not.toContain('cookie-91c2');
    expect(serialized).not.toContain('token-62bd');
    expect(serialized).not.toContain('key-4a91');
    expect(serialized).toContain('resource-51a0');
    expect(JSON.parse(serialized)).toEqual({
      requestId: 'req-5e10',
      headers: REDACTED_PLACEHOLDER,
      auth: REDACTED_PLACEHOLDER,
      resourceId: 'resource-51a0',
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('strips credentials, path, query and fragment from a URL', () => {
    const result = redactEvidence(
      'https://user:pa55@example.test/private/path?token=query-secret#fragment',
    );

    expect(result).toBe('https://example.test/');
  });

  it('redacts URLs embedded in longer strings', () => {
    const result = redactEvidence({
      message:
        'request to https://user:pa55@example.test/private?token=query-secret failed',
    });
    const serialized = JSON.stringify(result);

    expect(serialized).toContain('https://example.test/');
    expect(serialized).not.toContain('pa55');
    expect(serialized).not.toContain('query-secret');
    expect(serialized).not.toContain('/private');
  });

  it('replaces explicit secrets anywhere inside strings', () => {
    const result = redactEvidence(
      { note: `env=${SENSITIVE_ENV_VALUE} raw`, nested: [SENSITIVE_ENV_VALUE] },
      [SENSITIVE_ENV_VALUE],
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(SENSITIVE_ENV_VALUE);
    expect(serialized).toContain(REDACTED_PLACEHOLDER);
  });

  it('replaces the user home prefix with a tilde', () => {
    const home = homedir();

    const result = redactEvidence({ path: join(home, 'workspace', 'fixture') });

    expect(result).toEqual({ path: '~/workspace/fixture' });
  });

  it('redacts non-HTTP URLs such as the Doubao WebSocket endpoint', () => {
    const result = redactEvidence(
      'wss://asr.example.test/v1/realtime?token=abc123&resource=res01',
    );

    expect(result).toBe('wss://asr.example.test/');
  });

  it('redacts credentials embedded in free-form header strings', () => {
    const result = redactEvidence({
      output: 'Authorization: Bearer sk-live-abcdef123456',
      error: 'failed with access_token=abcd1234efgh',
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('sk-live-abcdef123456');
    expect(serialized).not.toContain('abcd1234efgh');
    expect(serialized).toContain('[REDACTED]');
  });

  it('treats oauth and authentication keys as sensitive', () => {
    const result = redactEvidence({
      oauth: { clientSecret: 'oauth-secret-123' },
      authentication: 'authentication-value-456',
    });

    expect(result).toEqual({
      oauth: REDACTED_PLACEHOLDER,
      authentication: REDACTED_PLACEHOLDER,
    });
  });
});

describe('writeEvidence', () => {
  it('rejects ids that are not test ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 's00-evidence-'));

    await expect(
      writeEvidence(
        {
          id: '../secret',
          status: 'PASS',
          summary: 'invalid id',
          observedAt: null,
        },
        root,
      ),
    ).rejects.toThrow(/SDK|CLI|PROTO|ASR/);
  });

  it('writes redacted JSON under the evidence root without mutating the record', async () => {
    const root = mkdtempSync(join(tmpdir(), 's00-evidence-'));
    const record = {
      id: 'SDK-01',
      status: 'PASS' as const,
      summary: 'settings loaded',
      observedAt: '2026-11-10T00:00:00.000Z',
      data: {
        authorization: SENSITIVE_ENV_VALUE,
        endpoint: 'https://user:pa55@example.test/v1?token=query-secret',
      },
    };
    const before = JSON.stringify(record);

    const written = await writeEvidence(record, root);

    expect(written).toBe(join(root, 'SDK-01.json'));
    const content = readFileSync(written, 'utf8');
    expect(content).not.toContain(SENSITIVE_ENV_VALUE);
    expect(content).not.toContain('pa55');
    expect(content).not.toContain('query-secret');
    expect(content).toContain('https://example.test/');
    expect(JSON.stringify(record)).toBe(before);
  });

  it('accepts caller-supplied secrets when writing evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 's00-evidence-'));
    const callerSecret = 'caller-supplied-secret-77';

    const written = await writeEvidence(
      {
        id: 'SDK-02',
        status: 'PASS',
        summary: `failed with ${callerSecret}`,
        observedAt: null,
      },
      root,
      [callerSecret],
    );

    expect(readFileSync(written, 'utf8')).not.toContain(callerSecret);
  });
});