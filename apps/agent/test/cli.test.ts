import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCli } from '../src/cli.js';
import { loadConfig } from '../src/config/load.js';

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
      'https://macbook.example-tailnet.ts.net',
    ]);

    const config = await loadConfig(configDir);
    expect(config.workspace).toMatchObject({
      displayName: 'CLI Fixture',
      workspaceId: 'default',
    });
  });
});