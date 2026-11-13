import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseAgentConfigV4,
  readConfigV4IfExists,
  resolveDatabasePath,
} from '../src/config/config-v4.js';
import { resolveAgentPaths } from '../src/config/paths.js';

const valid = {
  version: 4,
  desktopId: 'desktop_1',
  database: { file: 'agent.sqlite3' },
  listen: { host: '127.0.0.1', port: 8787 },
  tailscale: { baseUrl: 'https://mac.example-tailnet.ts.net' },
};

describe('AgentConfigV4', () => {
  it('accepts only bootstrap fields and rejects a second fact source', () => {
    expect(parseAgentConfigV4(valid)).toEqual(valid);
    expect(() =>
      parseAgentConfigV4({ ...valid, workspaces: [] }),
    ).toThrow(/INVALID_CONFIG/);
    expect(() =>
      parseAgentConfigV4({ ...valid, devices: [] }),
    ).toThrow(/INVALID_CONFIG/);
    expect(() =>
      parseAgentConfigV4({ ...valid, database: { file: '/tmp/agent.sqlite3' } }),
    ).toThrow(/INVALID_CONFIG/);
    expect(() =>
      parseAgentConfigV4({ ...valid, listen: { host: '0.0.0.0', port: 8787 } }),
    ).toThrow(/INVALID_CONFIG/);
  });

  it('returns null for V3 and resolves the database inside configDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 's04-v4-'));
    const paths = resolveAgentPaths(dir);
    writeFileSync(paths.agentFile, JSON.stringify({ version: 3 }));
    expect(readConfigV4IfExists(dir)).toBeNull();
    expect(resolveDatabasePath(dir, parseAgentConfigV4(valid))).toBe(
      join(dir, 'agent.sqlite3'),
    );
  });
});