import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentConfigV3 } from '../src/config/config-v3.js';
import { PairingService } from '../src/pairing/pairing-service.js';
import { DeviceStore } from '../src/store/device-store.js';
import { createPhoneServer } from '../src/transport/phone-server.js';
import {
  MobileApprovalMode,
  WorkspaceRecord,
} from '../src/workspace/workspace-types.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';

const BASE_URL = 'https://macbook.example-tailnet.ts.net';
const FIXED_NOW = 1_762_432_800_000;

let configDir: string;
let fixtureA: string;
let fixtureB: string;
let fixtureC: string;

interface Harness {
  manager: WorkspaceManager;
  written: AgentConfigV3[];
  changes: Array<{ workspaceId: string; mode: MobileApprovalMode }>;
  failWrites: (fail: boolean) => void;
}

function v3Config(workspaces: WorkspaceRecord[]): AgentConfigV3 {
  return {
    version: 3,
    desktopId: 'desktop_test',
    workspaces,
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: BASE_URL },
  };
}

async function records(): Promise<WorkspaceRecord[]> {
  return [
    {
      workspaceId: 'ws_a',
      displayName: 'Fixture Alpha',
      rootPath: await realpath(fixtureA),
      createdAt: FIXED_NOW,
      policy: { perSessionQueueLimit: 20, mobileApprovalMode: 'deny' },
    },
    {
      workspaceId: 'ws_b',
      displayName: 'Fixture Beta',
      rootPath: await realpath(fixtureB),
      createdAt: FIXED_NOW + 1,
      policy: { perSessionQueueLimit: 5, mobileApprovalMode: 'deny' },
    },
  ];
}

function setup(config: AgentConfigV3): Harness {
  const written: AgentConfigV3[] = [];
  const changes: Array<{ workspaceId: string; mode: MobileApprovalMode }> = [];
  let failing = false;
  const manager = new WorkspaceManager({
    configDir,
    config,
    writeConfig: (_dir, next) => {
      if (failing) throw new Error('disk full');
      written.push(next);
    },
    onApprovalModeChanged: (workspaceId, mode) => {
      changes.push({ workspaceId, mode });
    },
  });
  return {
    manager,
    written,
    changes,
    failWrites: (value) => {
      failing = value;
    },
  };
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 's03-approval-policy-'));
  fixtureA = join(configDir, 'fixture-a');
  fixtureB = join(configDir, 'fixture-b');
  fixtureC = join(configDir, 'fixture-c');
  await mkdir(fixtureA);
  await mkdir(fixtureB);
  await mkdir(fixtureC);
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe('WorkspaceManager approval policy', () => {
  it('changes only the selected workspace', async () => {
    const harness = setup(v3Config(await records()));

    const updated = harness.manager.setApprovalMode('ws_a', 'allow_once');

    expect(updated).toEqual({
      workspaceId: 'ws_a',
      displayName: 'Fixture Alpha',
      mobileApprovalMode: 'allow_once',
    });
    expect(harness.manager.approvalMode('ws_b')).toBe('deny');
    const last = harness.written.at(-1);
    expect(
      last?.workspaces.map((entry) => entry.policy.mobileApprovalMode),
    ).toEqual(['allow_once', 'deny']);
    expect(
      last?.workspaces.map((entry) => entry.policy.perSessionQueueLimit),
    ).toEqual([20, 5]);
  });

  it('notifies the listener once after the write, and not for a no-op', async () => {
    const harness = setup(v3Config(await records()));

    harness.manager.setApprovalMode('ws_a', 'allow_once');
    harness.manager.setApprovalMode('ws_a', 'allow_once');

    expect(harness.changes).toEqual([
      { workspaceId: 'ws_a', mode: 'allow_once' },
    ]);
  });

  it('does not change memory or notify when the write fails', async () => {
    const harness = setup(v3Config(await records()));
    harness.failWrites(true);

    expect(() =>
      harness.manager.setApprovalMode('ws_a', 'allow_once'),
    ).toThrow('disk full');
    expect(harness.manager.approvalMode('ws_a')).toBe('deny');
    expect(harness.changes).toEqual([]);
  });

  it('rejects unknown workspaces and invalid modes', async () => {
    const harness = setup(v3Config(await records()));

    expect(() => harness.manager.setApprovalMode('ws_missing', 'deny')).toThrow(
      'WORKSPACE_NOT_FOUND',
    );
    // @ts-expect-error 运行期必须拒绝非法模式
    expect(() => harness.manager.setApprovalMode('ws_a', 'always')).toThrow(
      'INVALID_MESSAGE',
    );
    expect(harness.manager.approvalMode('ws_a')).toBe('deny');
  });

  it('creates new workspaces with deny and keeps the mode on rename', async () => {
    const harness = setup(v3Config(await records()));

    const added = await harness.manager.add({
      path: fixtureC,
      displayName: 'Fixture Gamma',
    });
    expect(added.policy.mobileApprovalMode).toBe('deny');

    harness.manager.setApprovalMode('ws_a', 'allow_once');
    const renamed = await harness.manager.rename('ws_a', 'Alpha 2');
    expect(renamed.mobileApprovalMode).toBe('allow_once');
    expect(harness.manager.approvalMode('ws_a')).toBe('allow_once');
  });

  it('never exposes rootPath in the approval summary', async () => {
    const harness = setup(v3Config(await records()));

    const summary = harness.manager.setApprovalMode('ws_a', 'allow_once');

    expect(JSON.stringify(summary)).not.toContain(fixtureA);
  });

  it('does not serve a mutating approval route on the phone server', async () => {
    const store = new DeviceStore(configDir);
    const app = await createPhoneServer({
      pairingService: new PairingService({
        deviceStore: store,
        desktopId: 'desktop_test',
        baseUrl: BASE_URL,
      }),
      deviceStore: store,
      workspace: { workspaceId: 'ws_a', displayName: 'Fixture Alpha' },
      onConnection: () => undefined,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/v1/workspaces/set-approval',
        payload: { workspaceId: 'ws_a', mode: 'allow_once' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});