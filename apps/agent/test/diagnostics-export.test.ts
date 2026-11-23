import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildDiagnostics,
  redact,
  writeDiagnostics,
} from '../src/diagnostics/export.js';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('diagnostics export', () => {
  it('keeps only the log tail and redacts secrets', async () => {
    const directory = await tempDir('s06-export-');
    await writeFile(
      join(directory, 'agent.log'),
      [
        '{"event":"first","deviceToken":"secret-token"}',
        '{"event":"second","authorization":"Bearer abc123"}',
        '{"event":"third","index":3}',
        '',
      ].join('\n'),
    );

    const bundle = await buildDiagnostics({
      configDir: directory,
      platform: 'linux',
      logLines: 2,
    });
    const logs = bundle.logs.join('\n');

    expect(bundle.logs).toHaveLength(2);
    expect(logs).not.toContain('secret-token');
    expect(logs).not.toContain('Bearer abc123');
    expect(logs).toContain('[REDACTED]');
    expect(logs).toContain('"third"');
    expect(bundle.note).toContain('Metadata only');
  });

  it('writes the bundle with 0600 even when the file exists', async () => {
    const directory = await tempDir('s06-export-mode-');
    const output = join(directory, 'diagnostics.json');
    await writeFile(output, 'old', { mode: 0o644 });
    const bundle = await buildDiagnostics({
      configDir: directory,
      platform: 'linux',
    });

    await writeDiagnostics(bundle, output);

    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await readFile(output, 'utf8')) as unknown;
    expect(parsed).toMatchObject({ note: expect.stringContaining('Metadata only') });
  });

  it('redacts bearer tokens, device tokens and pairing codes', () => {
    const text =
      'authorization: Bearer token123 {"deviceToken":"abc","code":"pairing"}';

    const output = redact(text);

    expect(output).not.toContain('token123');
    expect(output).not.toContain('"abc"');
    expect(output).not.toContain('"pairing"');
  });

  it('returns no logs when the log file is missing', async () => {
    const directory = await tempDir('s06-export-empty-');

    const bundle = await buildDiagnostics({
      configDir: directory,
      platform: 'linux',
    });

    expect(bundle.logs).toEqual([]);
    expect(bundle.files[0]?.bytes).toBeNull();
  });

  it('accepts an injected endpoint command runner', async () => {
    const directory = await tempDir('s06-export-runner-');

    const bundle = await buildDiagnostics({
      configDir: directory,
      platform: 'darwin',
      runCommand: async () => 'No serve config',
    });

    const tailscale = bundle.doctor.checks.find(
      (check) => check.id === 'endpoint',
    );
    expect(tailscale?.status).toBe('warn');
  });
});