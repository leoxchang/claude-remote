import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockManagedRunDriver } from '../src/adapter/mock-managed-run-driver.js';
import { ApprovalStore } from '../src/approval/approval-store.js';
import { PermissionBroker } from '../src/approval/permission-broker.js';
import { RunApprovalBridge } from '../src/approval/run-approval-bridge.js';
import { PermissionResponseInput } from '../src/approval/approval-types.js';
import { AgentConfigV3 } from '../src/config/config-v3.js';
import { DeviceRecord } from '../src/domain/types.js';
import { EventJournal } from '../src/events/journal.js';
import { EventNormalizer } from '../src/events/normalizer.js';
import { ManagedRunController } from '../src/run/run-controller.js';
import { RunScheduler } from '../src/run/run-scheduler.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';
import { makeRequest } from './approval-test-harness.js';

const FIXED_NOW = 1_762_432_800_000;

let configDir: string;
let workspaceDir: string;

class FakeDevices {
  readonly records: DeviceRecord[] = ['device_1', 'device_2'].map((deviceId) => ({
    deviceId,
    deviceName: deviceId,
    tokenHash: 'hash',
    createdAt: '2026-11-12T00:00:00.000Z',
    revokedAt: null,
  }));

  list(): DeviceRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  revoke(deviceId: string): void {
    const index = this.records.findIndex((record) => record.deviceId === deviceId);
    const current = this.records[index];
    if (current === undefined) return;
    this.records[index] = {
      ...current,
      revokedAt: '2026-11-12T00:00:01.000Z',
    };
  }
}

interface Harness {
  workspaces: WorkspaceManager;
  sessions: SessionRegistry;
  scheduler: RunScheduler;
  controller: ManagedRunController;
  broker: PermissionBroker;
  store: ApprovalStore;
  devices: FakeDevices;
  journal: EventJournal;
  workspaceId: string;
}

async function setup(): Promise<Harness> {
  const devices = new FakeDevices();
  let brokerRef: PermissionBroker | null = null;
  let schedulerRef: RunScheduler | null = null;
  const config: AgentConfigV3 = {
    version: 3,
    desktopId: 'desktop_test',
    workspaces: [
      {
        workspaceId: 'ws_alpha',
        displayName: 'Fixture Alpha',
        rootPath: await realpath(workspaceDir),
        createdAt: FIXED_NOW,
        policy: { perSessionQueueLimit: 20, mobileApprovalMode: 'allow_once' },
      },
    ],
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: 'https://macbook-pro.tail0970fd.ts.net' },
  };
  const workspaces = new WorkspaceManager({
    configDir,
    config,
    usage: {
      hasActiveOrQueued: (workspaceId) =>
        schedulerRef?.hasActiveOrQueued(workspaceId) ?? false,
    },
    writeConfig: () => undefined,
    onApprovalModeChanged: (_workspaceId, mode) => {
      if (mode === 'deny') {
        brokerRef?.invalidateWorkspace('ws_alpha', 'policy_disabled');
      }
    },
  });
  const sessions = new SessionRegistry({ now: () => FIXED_NOW });
  const journal = new EventJournal();
  const normalizer = new EventNormalizer(journal);
  const scheduler = new RunScheduler({
    sessions,
    workspaces,
    journal,
    driver: new MockManagedRunDriver(),
    now: () => FIXED_NOW,
  });
  const store = new ApprovalStore();
  const bridge = new RunApprovalBridge({
    scheduler,
    workspaces,
    devices,
    journal,
    normalizer,
  });
  const broker = new PermissionBroker({
    store,
    ports: bridge,
    events: bridge,
  });
  brokerRef = broker;
  schedulerRef = scheduler;
  scheduler.setPermissionBroker(broker);
  const controller = new ManagedRunController({
    scheduler,
    sessions,
    normalizer,
    permissionBroker: broker,
  });
  return {
    workspaces,
    sessions,
    scheduler,
    controller,
    broker,
    store,
    devices,
    journal,
    workspaceId: 'ws_alpha',
  };
}

interface PendingRun {
  sessionId: string;
  runId: string;
  approvalId: string;
  result: Promise<unknown>;
}

async function startPending(
  harness: Harness,
  deviceId: string,
  index: number,
): Promise<PendingRun> {
  const session = harness.sessions.create({
    workspaceId: harness.workspaceId,
  });
  const accepted = await harness.controller.sendPrompt(
    session.sessionId,
    'hello',
    `cmd_${index}`,
    `trace_${index}`,
    deviceId,
  );
  const result = harness.broker.request(
    accepted.runId,
    makeRequest({
      requestId: `req_${index}`,
      toolUseID: `toolu_${index}`,
    }),
  );
  const record = harness.store.pendingForRun(accepted.runId)[0];
  if (record === undefined) throw new Error('pending approval was not created');
  return {
    sessionId: session.sessionId,
    runId: accepted.runId,
    approvalId: record.approvalId,
    result,
  };
}

function respondInput(
  harness: Harness,
  pending: PendingRun,
  decision: 'allow_once' | 'deny',
  deviceId: string = 'device_1',
): PermissionResponseInput {
  const record = harness.store.getById(pending.approvalId);
  if (record === null) throw new Error('approval not found');
  return {
    approvalId: pending.approvalId,
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    runId: record.runId,
    deviceId,
    commandId: `cmd_respond_${pending.approvalId}`,
    decision,
  };
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 's03-lifecycle-'));
  workspaceDir = join(configDir, 'fixture-alpha');
  await mkdir(workspaceDir);
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe('Approval lifecycle wiring', () => {
  it('invalidates pending approvals when a workspace is disabled without cancelling the run', async () => {
    const harness = await setup();
    const pending = await startPending(harness, 'device_1', 1);
    expect(
      harness.sessions.get(pending.sessionId).activeRun,
    ).toMatchObject({ status: 'waiting_approval', pendingApprovalCount: 1 });

    harness.workspaces.setApprovalMode(harness.workspaceId, 'deny');

    expect(harness.store.getById(pending.approvalId)).toMatchObject({
      status: 'invalidated',
      resolutionReason: 'policy_disabled',
    });
    await expect(pending.result).resolves.toMatchObject({ behavior: 'deny' });
    const run = harness.sessions
      .get(pending.sessionId)
      .runsById.get(pending.runId);
    expect(run?.status).not.toBe('cancelled');
    expect(run?.pendingApprovalCount).toBe(0);

    harness.workspaces.setApprovalMode(harness.workspaceId, 'allow_once');
    expect(harness.store.getById(pending.approvalId)?.status).toBe('invalidated');
    expect(harness.store.globalPendingCount()).toBe(0);
  });

  it('invalidates only approvals bound to the revoked device', async () => {
    const harness = await setup();
    const first = await startPending(harness, 'device_1', 1);
    const second = await startPending(harness, 'device_2', 2);

    harness.devices.revoke('device_1');
    expect(harness.broker.invalidateDevice('device_1', 'device_revoked')).toBe(1);

    expect(harness.store.getById(first.approvalId)).toMatchObject({
      status: 'invalidated',
      resolutionReason: 'device_revoked',
    });
    expect(harness.store.getById(second.approvalId)?.status).toBe('pending');
  });

  it('invalidates all pending approvals on graceful shutdown', async () => {
    const harness = await setup();
    const first = await startPending(harness, 'device_1', 1);
    const second = await startPending(harness, 'device_2', 2);

    expect(harness.broker.invalidateAll('agent_shutdown')).toBe(2);

    for (const pending of [first, second]) {
      expect(harness.store.getById(pending.approvalId)).toMatchObject({
        status: 'invalidated',
        resolutionReason: 'agent_shutdown',
      });
      await expect(pending.result).resolves.toMatchObject({ behavior: 'deny' });
    }
  });

  it('keeps sessions and workspaces busy while an approval is pending', async () => {
    const harness = await setup();
    const pending = await startPending(harness, 'device_1', 1);
    const session = harness.sessions.get(pending.sessionId);

    expect(() => harness.sessions.archive(session.sessionId)).toThrow(
      'SESSION_BUSY',
    );
    await expect(harness.workspaces.remove(harness.workspaceId)).rejects.toThrow(
      'WORKSPACE_BUSY',
    );
  });

  it('does not let queue removal affect an existing approval', async () => {
    const harness = await setup();
    const pending = await startPending(harness, 'device_1', 1);
    const queued = await harness.controller.sendPrompt(
      pending.sessionId,
      'second',
      'cmd_2',
      'trace_2',
      'device_1',
    );
    expect(queued.status).toBe('queued');

    await harness.controller.removeQueued(pending.sessionId, queued.runId);

    expect(harness.store.getById(pending.approvalId)?.status).toBe('pending');
    expect(harness.store.globalPendingCount()).toBe(1);
  });

  it('does not rewrite an approved_once approval when the run is cancelled', async () => {
    const harness = await setup();
    const pending = await startPending(harness, 'device_1', 1);
    harness.broker.respond(respondInput(harness, pending, 'allow_once'));

    await harness.controller.cancel(pending.sessionId, pending.runId);

    expect(harness.store.getById(pending.approvalId)).toMatchObject({
      status: 'approved_once',
      resolutionReason: 'user_allow_once',
    });
    expect(
      harness.journal
        .recent(pending.sessionId, 100)
        .filter((event) => event.type === 'permission.resolved'),
    ).toHaveLength(1);
  });
});