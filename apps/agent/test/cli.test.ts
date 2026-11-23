import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createCli } from '../src/cli.js';
import { loadConfig } from '../src/config/load.js';
import { initializeConfig } from '../src/config/initialize.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = join(REPO_ROOT, 'apps', 'agent', 'src', 'main.ts');
const BASE_URL = 'https://macbook.example-tailnet.ts.net';

async function fixture(): Promise<{
  configDir: string;
  workspace: string;
}> {
  const configDir = join(
    await mkdtemp(join(tmpdir(), 's06-cli-')),
    'config',
  );
  const workspace = await mkdtemp(join(tmpdir(), 's06-cli-ws-'));
  await initializeConfig({
    configDir,
    workspacePath: workspace,
    displayName: 'CLI Fixture',
    tailscaleBaseUrl: BASE_URL,
  });
  return { configDir, workspace };
}

describe('cli', () => {
  it('initializes the configuration through the init command', async () => {
    const configDir = join(await mkdtemp(join(tmpdir(), 's01-cli-')), 'config');
    const workspace = await mkdtemp(join(tmpdir(), 's01-cli-ws-'));
    const program = createCli(configDir);

    await program.parseAsync([
      'node',
      'claude-remote-agent',
      'init',
      '--workspace',
      workspace,
      '--name',
      'CLI Fixture',
      '--base-url',
      BASE_URL,
    ]);

    const config = await loadConfig(configDir);
    expect(config.workspace).toMatchObject({
      displayName: 'CLI Fixture',
      workspaceId: 'default',
    });
  });

  it('runs doctor through the CLI', async () => {
    const { configDir } = await fixture();

    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', ENTRY, 'doctor'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, CLAUDE_REMOTE_CONFIG_DIR: configDir },
      },
    );

    expect(output).toContain('"checks"');
    expect(output).toContain('"versions"');
  });

  it('exports diagnostics through the CLI', async () => {
    const { configDir } = await fixture();
    const output = join(configDir, 'diagnostics.json');
    const program = createCli(configDir);

    await program.parseAsync([
      'node',
      'claude-remote-agent',
      'diagnostics',
      'export',
      '--output',
      output,
    ]);

    const parsed = JSON.parse(await readFile(output, 'utf8')) as {
      note?: string;
    };
    expect(parsed.note).toContain('Metadata only');
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it('rejects malformed service environment assignments', async () => {
    const { configDir } = await fixture();
    const program = createCli(configDir);

    await expect(
      program.parseAsync([
        'node',
        'claude-remote-agent',
        'service',
        'install',
        '--env',
        'INVALID',
      ]),
    ).rejects.toThrow('KEY=VALUE');
  });
});