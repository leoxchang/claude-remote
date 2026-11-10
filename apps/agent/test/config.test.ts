import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { initializeConfig } from '../src/config/initialize.js';
import { loadConfig } from '../src/config/load.js';

interface Setup {
  configDir: string;
  workspacePath: string;
}

async function setup(): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), 's01-config-'));
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  return { configDir: join(root, 'config'), workspacePath };
}

const validInput = (setupValue: Setup): Parameters<typeof initializeConfig>[0] => ({
  configDir: setupValue.configDir,
  workspacePath: setupValue.workspacePath,
  displayName: 'S01 Fixture',
  tailscaleBaseUrl: 'https://macbook.example-tailnet.ts.net',
});

describe('initializeConfig', () => {
  it('creates the config directory and files with restrictive modes', async () => {
    const value = await setup();

    const config = await initializeConfig(validInput(value));

    const dirStat = await stat(value.configDir);
    const agentStat = await stat(join(value.configDir, 'agent.json'));
    const devicesStat = await stat(join(value.configDir, 'devices.json'));
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(agentStat.mode & 0o777).toBe(0o600);
    expect(devicesStat.mode & 0o777).toBe(0o600);
    expect(config).toEqual({
      version: 1,
      desktopId: expect.stringMatching(/^desktop_[A-Za-z0-9_-]+$/),
      workspace: {
        workspaceId: 'default',
        displayName: 'S01 Fixture',
        rootPath: await realpath(value.workspacePath),
      },
      listen: { host: '127.0.0.1', port: 8787 },
      tailscale: { baseUrl: 'https://macbook.example-tailnet.ts.net' },
    });
  });

  it('rejects a relative workspace path', async () => {
    const value = await setup();

    await expect(
      initializeConfig({ ...validInput(value), workspacePath: 'relative/path' }),
    ).rejects.toThrow(/absolute/i);
  });

  it('rejects a workspace path that is not an existing directory', async () => {
    const value = await setup();

    await expect(
      initializeConfig({
        ...validInput(value),
        workspacePath: join(value.workspacePath, 'missing'),
      }),
    ).rejects.toThrow(/does not exist|not a directory/i);
  });

  it('stores the resolved real path for a symlinked workspace', async () => {
    const value = await setup();
    const linkPath = join(await realpath(tmpdir()), `s01-link-${process.pid}`);
    await symlink(value.workspacePath, linkPath);

    const config = await initializeConfig({ ...validInput(value), workspacePath: linkPath });

    expect(config.workspace.rootPath).toBe(await realpath(value.workspacePath));
  });

  it('rejects a base url that is not https', async () => {
    const value = await setup();

    await expect(
      initializeConfig({
        ...validInput(value),
        tailscaleBaseUrl: 'http://macbook.example-tailnet.ts.net',
      }),
    ).rejects.toThrow(/https/i);
  });

  it('rejects a base url that is not a ts.net host', async () => {
    const value = await setup();

    await expect(
      initializeConfig({
        ...validInput(value),
        tailscaleBaseUrl: 'https://example.com',
      }),
    ).rejects.toThrow(/ts\.net/i);
  });

  it('refuses to overwrite an existing configuration', async () => {
    const value = await setup();
    const first = await initializeConfig(validInput(value));

    await expect(initializeConfig(validInput(value))).rejects.toThrow(/exists/i);

    const stored = await loadConfig(value.configDir);
    expect(stored.desktopId).toBe(first.desktopId);
  });
});

describe('loadConfig', () => {
  it('returns the stored configuration', async () => {
    const value = await setup();
    const created = await initializeConfig(validInput(value));

    expect(await loadConfig(value.configDir)).toEqual(created);
  });

  it('fails when the configuration is missing', async () => {
    const value = await setup();

    await expect(loadConfig(value.configDir)).rejects.toThrow(/agent\.json|not found/i);
  });

  it('rejects a configuration with an unexpected listen address', async () => {
    const value = await setup();
    await initializeConfig(validInput(value));
    const stored = JSON.parse(
      await readFile(join(value.configDir, 'agent.json'), 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(
      join(value.configDir, 'agent.json'),
      JSON.stringify({ ...stored, listen: { host: '0.0.0.0', port: 8787 } }),
    );

    await expect(loadConfig(value.configDir)).rejects.toThrow(/127\.0\.0\.1|listen/i);
  });
});