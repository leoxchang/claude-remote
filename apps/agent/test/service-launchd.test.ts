import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SERVICE_LABEL,
  buildLaunchAgentPlist,
  installLaunchAgent,
  launchAgentPlistPath,
  launchAgentStatus,
  uninstallLaunchAgent,
} from '../src/service/launchd.js';

const OPTIONS = {
  entryPath: '/repo/apps/agent/src/main.ts',
  workingDirectory: '/repo',
  configDir: '/home/tester/.claude-remote',
  nodePath: '/usr/bin/node',
  environment: { DOUBAO_ASR_API_KEY: 'se&cret' },
};

describe('launch agent', () => {
  it('builds a plist that restarts on crash and injects env', () => {
    const plist = buildLaunchAgentPlist(OPTIONS);

    expect(plist).toContain(`<key>Label</key>\n  <string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<string>/usr/bin/node</string>');
    expect(plist).toContain('<string>--import</string>');
    expect(plist).toContain('<string>tsx</string>');
    expect(plist).toContain('<string>/repo/apps/agent/src/main.ts</string>');
    expect(plist).toContain('<string>start</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<integer>10</integer>');
    expect(plist).toContain('<key>DOUBAO_ASR_API_KEY</key>');
    expect(plist).toContain('<string>se&amp;cret</string>');
    expect(plist).toContain('<key>CLAUDE_REMOTE_CONFIG_DIR</key>');
    expect(plist).toContain('/home/tester/.claude-remote/launchd.out.log');
  });

  it('installs the plist with 0600 and bootstraps the service', async () => {
    const home = await mkdtemp(join(tmpdir(), 's06-launchd-home-'));
    const calls: string[][] = [];
    const runCommand = async (
      command: string,
      args: string[],
    ): Promise<string> => {
      calls.push([command, ...args]);
      if (args[0] === 'bootout') throw new Error('not loaded');
      return '';
    };

    const result = await installLaunchAgent({
      ...OPTIONS,
      homeDir: home,
      runCommand,
    });

    expect(result.plistPath).toBe(launchAgentPlistPath(home));
    expect((await stat(result.plistPath)).mode & 0o777).toBe(0o600);
    const contents = await readFile(result.plistPath, 'utf8');
    expect(contents).toContain('DOUBAO_ASR_API_KEY');
    expect(calls.some((call) => call[1] === 'bootout')).toBe(true);
    expect(calls.some((call) => call[1] === 'bootstrap')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('se&cret');
  });

  it('uninstalls even when the service is not loaded', async () => {
    const home = await mkdtemp(join(tmpdir(), 's06-launchd-uninstall-'));
    const plistPath = launchAgentPlistPath(home);
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, 'plist');
    const runCommand = async (): Promise<string> => {
      throw new Error('not loaded');
    };

    const result = await uninstallLaunchAgent({ homeDir: home, runCommand });

    expect(result.removed).toBe(true);
    await expect(stat(plistPath)).rejects.toThrow();
  });

  it('reports status from launchctl print', async () => {
    const home = await mkdtemp(join(tmpdir(), 's06-launchd-status-'));
    const runCommand = async (): Promise<string> =>
      `${SERVICE_LABEL} = { ... }`;

    const result = await launchAgentStatus({ homeDir: home, runCommand });

    expect(result.installed).toBe(false);
    expect(result.loaded).toBe(true);
    expect(result.detail).toContain(SERVICE_LABEL);
  });

  it('runs compiled JavaScript entries without the tsx loader', () => {
    const plist = buildLaunchAgentPlist({
      ...OPTIONS,
      entryPath: '/repo/apps/agent/dist/main.js',
    });

    expect(plist).not.toContain('<string>--import</string>');
    expect(plist).toContain('<string>/repo/apps/agent/dist/main.js</string>');
  });

  it('uses the log directory override and current node by default', () => {
    const plist = buildLaunchAgentPlist({
      ...OPTIONS,
      nodePath: undefined,
      logDir: '/var/log/claude-remote',
    });

    expect(plist).toContain('<string>/var/log/claude-remote/launchd.out.log</string>');
    expect(plist).toContain(`<string>${process.execPath}</string>`);
  });

  it('surfaces a bootstrap failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 's06-launchd-fail-'));
    const runCommand = async (
      _command: string,
      args: string[],
    ): Promise<string> => {
      if (args[0] === 'bootstrap') throw new Error('denied');
      return '';
    };

    await expect(
      installLaunchAgent({ ...OPTIONS, homeDir: home, runCommand }),
    ).rejects.toThrow(/bootstrap failed/);
  });

  it('reports not loaded when launchctl print fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 's06-launchd-notloaded-'));
    const runCommand = async (): Promise<string> => {
      throw new Error('not loaded');
    };

    const result = await launchAgentStatus({ homeDir: home, runCommand });

    expect(result.loaded).toBe(false);
    expect(result.detail).toBe('not loaded');
  });

  it('reports nothing removed when the plist is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 's06-launchd-absent-'));
    const runCommand = async (): Promise<string> => '';

    const result = await uninstallLaunchAgent({ homeDir: home, runCommand });

    expect(result.removed).toBe(false);
  });

  it('falls back to the real launchctl for status', async () => {
    const home = await mkdtemp(join(tmpdir(), 's06-launchd-real-'));

    const result = await launchAgentStatus({ homeDir: home });

    expect(result.installed).toBe(false);
    expect(typeof result.loaded).toBe('boolean');
  });
});