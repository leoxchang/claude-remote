import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RUN_STATUSES } from '../src/domain/types.js';

interface AgentPackageJson {
  name?: unknown;
  engines?: { node?: unknown };
  dependencies?: Record<string, unknown>;
}

const agentPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as AgentPackageJson;

describe('agent bootstrap', () => {
  it('declares the pinned package identity and SDK version', () => {
    expect(agentPackage.name).toBe('@claude-remote/agent');
    expect(agentPackage.engines?.node).toBe('>=22');
    expect(agentPackage.dependencies?.['@anthropic-ai/claude-agent-sdk']).toBe(
      '0.3.319',
    );
  });

  it('exposes the S01 run statuses in order', () => {
    expect(RUN_STATUSES).toEqual([
      'queued',
      'starting',
      'running',
      'cancelling',
      'succeeded',
      'failed',
      'cancelled',
      'interrupted',
    ]);
  });
});