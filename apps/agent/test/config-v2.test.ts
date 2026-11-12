import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  migrateConfigV1ToV2,
  parseAgentConfigV2,
  validateDisplayName,
  writeConfigV2Atomic,
  writeConfigV2AtomicSync,
} from '../src/config/config-v2.js';

const TAILSCALE_URL = 'https://macbook-pro.tail0970fd.ts.net';

const V1_CONFIG = {
  version: 1,
  desktopId: 'desktop_01',
  workspace: {
    workspaceId: 'default',
    displayName: 'Fixture Alpha',
    rootPath: '/tmp/fixture-alpha',
  },
  listen: { host: '127.0.0.1', port: 8787 },
  tailscale: { baseUrl: TAILSCALE_URL },
};

function workspace(index: number): Record<string, unknown> {
  return {
    workspaceId: `ws_${index}`,
    displayName: `Workspace ${index}`,
    rootPath: `/tmp/fixture-${index}`,
    createdAt: 1_762_432_800_000 + index,
    policy: { perSessionQueueLimit: 20 },
  };
}

function v2Config(workspaces: unknown[]): Record<string, unknown> {
  return {
    version: 2,
    desktopId: 'desktop_01',
    workspaces,
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: TAILSCALE_URL },
  };
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'claude-remote-config-'));
});

afterEach(async () => {
  await chmod(configDir, 0o700).catch(() => undefined);
  await rm(configDir, { recursive: true, force: true });
});

describe('validateDisplayName', () => {
  it('counts Unicode code points rather than UTF-16 units', () => {
    expect(validateDisplayName('🙂'.repeat(80))).toHaveLength(160);
    expect(() => validateDisplayName('🙂'.repeat(81))).toThrow('INVALID_MESSAGE');
    expect(() => validateDisplayName('bad\nname')).toThrow('INVALID_MESSAGE');
  });

  it('trims surrounding whitespace and rejects blank names', () => {
    expect(validateDisplayName('  Fixture Alpha  ')).toBe('Fixture Alpha');
    expect(() => validateDisplayName('   ')).toThrow('INVALID_MESSAGE');
    expect(() => validateDisplayName('bad\u0007name')).toThrow('INVALID_MESSAGE');
  });
});

describe('migrateConfigV1ToV2', () => {
  it('maps the single V1 workspace into a V2 list', () => {
    const migrated = migrateConfigV1ToV2(V1_CONFIG);

    expect(migrated.version).toBe(2);
    expect(migrated.desktopId).toBe('desktop_01');
    expect(migrated.workspaces).toHaveLength(1);
    expect(migrated.workspaces[0]).toMatchObject({
      workspaceId: 'default',
      displayName: 'Fixture Alpha',
      rootPath: '/tmp/fixture-alpha',
      policy: { perSessionQueueLimit: 20 },
    });
    expect(typeof migrated.workspaces[0]?.createdAt).toBe('number');
    expect(migrated.tailscale.baseUrl).toBe(TAILSCALE_URL);
  });

  it('accepts an already migrated V2 config', () => {
    const config = v2Config([workspace(1)]);

    const parsed = migrateConfigV1ToV2(config);

    expect(parsed.workspaces[0]?.workspaceId).toBe('ws_1');
  });

  it('rejects a V1 config without the fixed workspace id', () => {
    const broken = {
      ...V1_CONFIG,
      workspace: { ...V1_CONFIG.workspace, workspaceId: 'ws_other' },
    };

    expect(() => migrateConfigV1ToV2(broken)).toThrow('INVALID_CONFIG');
  });

  it('rejects an unknown config version', () => {
    expect(() => migrateConfigV1ToV2({ ...V1_CONFIG, version: 3 })).toThrow(
      'INVALID_CONFIG',
    );
  });
});

describe('parseAgentConfigV2', () => {
  it('defaults the queue limit to 20 and accepts 1–20', () => {
    const withoutPolicy = workspace(1) as Record<string, unknown>;
    delete withoutPolicy['policy'];

    const parsed = parseAgentConfigV2(v2Config([withoutPolicy, workspace(2)]));

    expect(parsed.workspaces[0]?.policy.perSessionQueueLimit).toBe(20);
    const withOne = workspace(2) as Record<string, unknown>;
    withOne['policy'] = { perSessionQueueLimit: 1 };
    expect(
      parseAgentConfigV2(v2Config([withOne])).workspaces[0]?.policy
        .perSessionQueueLimit,
    ).toBe(1);
  });

  it('rejects queue limits outside 1–20 and non-integers', () => {
    for (const limit of [0, 21, 2.5]) {
      const entry = workspace(1) as Record<string, unknown>;
      entry['policy'] = { perSessionQueueLimit: limit };
      expect(() => parseAgentConfigV2(v2Config([entry]))).toThrow(
        'INVALID_CONFIG',
      );
    }
  });

  it('accepts 50 workspaces and rejects 51', () => {
    const fifty = Array.from({ length: 50 }, (_unused, index) => workspace(index));
    expect(parseAgentConfigV2(v2Config(fifty)).workspaces).toHaveLength(50);

    const fiftyOne = [
      ...fifty,
      workspace(50),
    ];
    expect(() => parseAgentConfigV2(v2Config(fiftyOne))).toThrow(
      'TOO_MANY_WORKSPACES',
    );
  });

  it('rejects duplicate workspace ids and invalid display names', () => {
    expect(() =>
      parseAgentConfigV2(v2Config([workspace(1), workspace(1)])),
    ).toThrow('INVALID_CONFIG');

    const badName = workspace(2) as Record<string, unknown>;
    badName['displayName'] = '🙂'.repeat(81);
    expect(() => parseAgentConfigV2(v2Config([badName]))).toThrow(
      'INVALID_MESSAGE',
    );
  });
});

describe('writeConfigV2Atomic', () => {
  it('keeps a 0600 backup of the V1 file before replacing it', async () => {
    const agentFile = join(configDir, 'agent.json');
    await writeFile(agentFile, `${JSON.stringify(V1_CONFIG, null, 2)}\n`, {
      mode: 0o600,
    });
    const migrated = migrateConfigV1ToV2(V1_CONFIG);

    await writeConfigV2Atomic(configDir, migrated);

    const backup = await readFile(join(configDir, 'agent.json.v1.bak'), 'utf8');
    expect(JSON.parse(backup)).toMatchObject({ version: 1 });
    expect((await stat(join(configDir, 'agent.json.v1.bak'))).mode & 0o777).toBe(
      0o600,
    );
    const written = JSON.parse(await readFile(agentFile, 'utf8')) as {
      version: number;
    };
    expect(written.version).toBe(2);
    expect((await stat(agentFile)).mode & 0o777).toBe(0o600);
  });

  it('does not replace the original file when the write fails', async () => {
    const agentFile = join(configDir, 'agent.json');
    const original = `${JSON.stringify(V1_CONFIG, null, 2)}\n`;
    await writeFile(agentFile, original, { mode: 0o600 });
    await chmod(configDir, 0o500);

    await expect(
      writeConfigV2Atomic(configDir, migrateConfigV1ToV2(V1_CONFIG)),
    ).rejects.toBeDefined();

    await chmod(configDir, 0o700);
    expect(await readFile(agentFile, 'utf8')).toBe(original);
  });

  it('writes synchronously for same-tick in-memory swaps', async () => {
    const migrated = migrateConfigV1ToV2(V1_CONFIG);

    writeConfigV2AtomicSync(configDir, migrated);

    const written = JSON.parse(
      await readFile(join(configDir, 'agent.json'), 'utf8'),
    ) as { version: number };
    expect(written.version).toBe(2);
    expect((await stat(join(configDir, 'agent.json'))).mode & 0o777).toBe(0o600);
  });
});