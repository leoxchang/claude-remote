import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AGENT_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SDK_VERSION,
  agentVersions,
} from '../src/app/versions.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_PACKAGE = join(TEST_DIR, '..', 'package.json');
const ROOT_PACKAGE = join(TEST_DIR, '..', '..', '..', 'package.json');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): unknown {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

describe('agent versions', () => {
  it('exposes the full version view', () => {
    expect(agentVersions()).toEqual({
      agent: '0.0.0',
      sdk: '0.3.319',
      runtime: '2.1.319',
      protocol: 1,
    });
    expect(PROTOCOL_VERSION).toBe(1);
    expect(RUNTIME_VERSION).toBe('2.1.319');
  });

  it('keeps agent and SDK versions in sync with package manifests', () => {
    expect(stringField(readJson(AGENT_PACKAGE), 'version')).toBe(AGENT_VERSION);
    const dependencies = readJson(ROOT_PACKAGE)['dependencies'];
    const sdkVersion =
      typeof dependencies === 'object' && dependencies !== null
        ? (dependencies as Record<string, unknown>)['@anthropic-ai/claude-agent-sdk']
        : undefined;
    expect(sdkVersion).toBe(SDK_VERSION);
  });
});