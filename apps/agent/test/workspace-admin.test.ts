import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminClient } from '../src/admin/client.js';
import { AdminStatus, createAdminServer } from '../src/admin/server.js';
import { agentVersions } from '../src/app/versions.js';
import { AgentConfigV3 } from '../src/config/config-v3.js';
import { PairingService } from '../src/pairing/pairing-service.js';
import { DeviceStore } from '../src/store/device-store.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';

const BASE_URL = 'https://macbook.example-tailnet.ts.net';

let configDir: string;
let fixture: string;
let server: FastifyInstance | null = null;
let busy = false;

function emptyConfig(): AgentConfigV3 {
  return {
    version: 3,
    desktopId: 'desktop_test',
    workspaces: [],
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: BASE_URL },
  };
}

async function startAdmin(): Promise<AdminClient> {
  const store = new DeviceStore(configDir);
  const socketPath = join(configDir, 'agent.sock');
  const status: AdminStatus = {
    status: 'running',
    desktopId: 'desktop_test',
    listen: { host: '127.0.0.1', port: 8787 },
    activeDeviceId: null,
    versions: agentVersions(),
  };
  const workspaces = new WorkspaceManager({
    configDir,
    config: emptyConfig(),
    usage: { hasActiveOrQueued: () => busy },
  });
  server = await createAdminServer({
    socketPath,
    pairingService: new PairingService({
      deviceStore: store,
      desktopId: 'desktop_test',
      baseUrl: BASE_URL,
    }),
    deviceStore: store,
    workspaces,
    getStatus: () => status,
    onRevoke: () => undefined,
  });
  return new AdminClient(socketPath);
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 's02-admin-'));
  fixture = join(configDir, 'fixture-a');
  await mkdir(fixture);
  busy = false;
});

afterEach(async () => {
  await server?.close();
  server = null;
  await rm(configDir, { recursive: true, force: true });
});

describe('workspace admin routes', () => {
  it('adds, lists, renames and removes through the unix socket', async () => {
    const client = await startAdmin();

    const added = await client.workspaceAdd(fixture, 'Fixture Alpha');
    expect(added).toEqual({
      workspaceId: expect.stringMatching(/^ws_/),
      displayName: 'Fixture Alpha',
      mobileApprovalMode: 'deny',
    });

    expect(await client.workspaceList()).toEqual([added]);

    const renamed = await client.workspaceRename(
      added.workspaceId,
      'Fixture Alpha 2',
    );
    expect(renamed).toEqual({
      workspaceId: added.workspaceId,
      displayName: 'Fixture Alpha 2',
      mobileApprovalMode: 'deny',
    });

    const approved = await client.workspaceSetApproval(
      added.workspaceId,
      'allow_once',
    );
    expect(approved).toEqual({
      workspaceId: added.workspaceId,
      displayName: 'Fixture Alpha 2',
      mobileApprovalMode: 'allow_once',
    });

    await client.workspaceRemove(added.workspaceId);
    expect(await client.workspaceList()).toEqual([]);
  });

  it('maps busy removal and unknown ids to stable admin codes', async () => {
    const client = await startAdmin();
    const added = await client.workspaceAdd(fixture, 'Fixture Alpha');

    busy = true;
    await expect(client.workspaceRemove(added.workspaceId)).rejects.toMatchObject(
      { code: 'WORKSPACE_BUSY' },
    );

    busy = false;
    await expect(client.workspaceRemove('ws_missing')).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
    });
  });

  it('rejects an invalid path without echoing it', async () => {
    const client = await startAdmin();
    const missing = join(configDir, 'private-project-name');

    await expect(client.workspaceAdd(missing, 'Missing')).rejects.toMatchObject(
      { code: 'WORKSPACE_NOT_ALLOWED' },
    );
  });

  it('rejects an unknown approval mode and unknown workspace', async () => {
    const client = await startAdmin();
    const added = await client.workspaceAdd(fixture, 'Fixture Alpha');

    await expect(
      client.workspaceSetApproval(
        added.workspaceId,
        // @ts-expect-error 运行期必须拒绝非法 mode
        'always',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });

    await expect(
      client.workspaceSetApproval('ws_missing', 'deny'),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  });
});