import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import liveConfig from '../../../vitest.live.config.js';
import { CLI_VERSION, PROJECT_MARKER, SDK_VERSION } from '../src/constants.js';

interface PackageManifest {
  engines?: { node?: string };
  dependencies?: Readonly<Record<string, string>>;
}

interface FixtureSettings {
  permissions?: { ask?: readonly string[] };
}

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const readText = (relativePath: string): string =>
  readFileSync(`${REPO_ROOT}${relativePath}`, 'utf8');

const readJson = <T>(relativePath: string): T =>
  JSON.parse(readText(relativePath)) as T;

describe('S00 harness bootstrap', () => {
  it('pins the Agent SDK version and the Node engine floor', () => {
    const manifest = readJson<PackageManifest>('package.json');

    expect(manifest.dependencies?.['@anthropic-ai/claude-agent-sdk']).toBe(
      SDK_VERSION,
    );
    expect(SDK_VERSION).toBe('0.3.319');
    expect(manifest.engines?.node).toBe('>=22');
  });

  it('records the installed CLI version actually used for validation', () => {
    expect(CLI_VERSION).toBe('2.1.311');
  });

  it('ships an isolated fixture carrying the project marker', () => {
    const claudeMd = readText('spikes/s00-agent-sdk/fixture/CLAUDE.md');

    expect(claudeMd).toContain(PROJECT_MARKER);
  });

  it('asks for Bash permission in the fixture project settings', () => {
    const settings = readJson<FixtureSettings>(
      'spikes/s00-agent-sdk/fixture/.claude/settings.json',
    );

    expect(settings.permissions?.ask).toContain('Bash');
  });

  it('runs live tests serially', () => {
    expect(liveConfig.test?.fileParallelism).toBe(false);
    expect(liveConfig.test?.maxConcurrency).toBe(1);
  });
});