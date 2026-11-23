import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = join(REPO_ROOT, 'apps', 'agent', 'src', 'main.ts');

describe('agent CLI entry', () => {
  it('prints help through the real executable entry', () => {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', ENTRY, '--help'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 },
    );

    expect(output).toContain('init');
    expect(output).toContain('start');
    expect(output).toContain('doctor');
    expect(output).toContain('service');
  });
});