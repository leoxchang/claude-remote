import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentSdkAdapter } from '../../src/adapter/agent-sdk-adapter.js';
import { ApprovalStore } from '../../src/approval/approval-store.js';
import { PermissionBroker } from '../../src/approval/permission-broker.js';
import { RunApprovalBridge } from '../../src/approval/run-approval-bridge.js';
import {
  PermissionResponseResult,
} from '../../src/approval/approval-types.js';
import { AgentConfigV3 } from '../../src/config/config-v3.js';
import { EventJournal } from '../../src/events/journal.js';
import { EventNormalizer } from '../../src/events/normalizer.js';
import { ManagedRunController } from '../../src/run/run-controller.js';
import { RunScheduler } from '../../src/run/run-scheduler.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { WorkspaceManager } from '../../src/workspace/workspace-manager.js';

const TERMINAL_TIMEOUT_MS = 300_000;
const FIXED_NOW = 1_762_432_800_000;

interface LiveHarness {
  controller: ManagedRunController;
  scheduler: RunScheduler;
  sessions: SessionRegistry;
  journal: EventJournal;
  broker: PermissionBroker;
  store: ApprovalStore;
  workspaceId: string;
  cwd: string;
  settingsBefore: string;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = TERMINAL_TIMEOUT_MS,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function terminalStatus(
  sessions: SessionRegistry,
  sessionId: string,
  runId: string,
): string | undefined {
  return sessions.get(sessionId).runsById.get(runId)?.status;
}

async function waitForTerminal(
  harness: LiveHarness,
  sessionId: string,
  runId: string,
): Promise<string> {
  await waitFor(
    () => {
      const status = terminalStatus(harness.sessions, sessionId, runId);
      return (
        status === 'succeeded' ||
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'interrupted'
      );
    },
    `run ${runId} terminal`,
  );
  return terminalStatus(harness.sessions, sessionId, runId) ?? 'unknown';
}

interface PendingApproval {
  approvalId: string;
  sessionId: string;
  runId: string;
}

function pendingApprovals(harness: LiveHarness): PendingApproval[] {
  return harness.store.allPending().map((record) => ({
    approvalId: record.approvalId,
    sessionId: record.sessionId,
    runId: record.runId,
  }));
}

async function waitForPending(
  harness: LiveHarness,
  count: number,
): Promise<PendingApproval[]> {
  await waitFor(
    () => pendingApprovals(harness).length >= count,
    `${count} pending approval(s)`,
  );
  return pendingApprovals(harness);
}

function respond(
  harness: LiveHarness,
  pending: PendingApproval,
  decision: 'allow_once' | 'deny',
): PermissionResponseResult {
  const record = harness.store.getById(pending.approvalId);
  if (record === null) throw new Error('approval disappeared');
  return harness.broker.respond({
    approvalId: pending.approvalId,
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    runId: record.runId,
    deviceId: record.deviceId,
    commandId: `cmd_live_${pending.approvalId}_${decision}`,
    decision,
  });
}

async function buildHarness(): Promise<LiveHarness> {
  const cwd = await mkdtemp(join(tmpdir(), 's03-live-'));
  await mkdir(join(cwd, '.claude'), { recursive: true });
  const settingsPath = join(cwd, '.claude', 'settings.local.json');
  await writeFile(
    settingsPath,
    `${JSON.stringify({ permissions: { ask: ['Bash', 'Edit'] } }, null, 2)}\n`,
    'utf8',
  );
  const settingsBefore = await readFile(settingsPath, 'utf8');
  const config: AgentConfigV3 = {
    version: 3,
    desktopId: 'desktop_live',
    workspaces: [
      {
        workspaceId: 'ws_live',
        displayName: 'S03 Live Fixture',
        rootPath: await realpath(cwd),
        createdAt: FIXED_NOW,
        policy: { perSessionQueueLimit: 20, mobileApprovalMode: 'allow_once' },
      },
    ],
    listen: { host: '127.0.0.1', port: 8787 },
    tailscale: { baseUrl: 'https://macbook-pro.tail0970fd.ts.net' },
  };
  const workspaces = new WorkspaceManager({
    configDir: cwd,
    config,
    writeConfig: () => undefined,
  });
  const sessions = new SessionRegistry({ now: () => FIXED_NOW });
  const journal = new EventJournal();
  const normalizer = new EventNormalizer(journal);
  const scheduler = new RunScheduler({
    sessions,
    workspaces,
    journal,
    driver: new AgentSdkAdapter(),
    now: () => Date.now(),
  });
  const store = new ApprovalStore();
  const bridge = new RunApprovalBridge({
    scheduler,
    workspaces,
    devices: {
      list: () => [
        {
          deviceId: 'device_live',
          deviceName: 'Mac fixture',
          tokenHash: 'hash',
          createdAt: '2026-11-12T00:00:00.000Z',
          revokedAt: null,
        },
      ],
    },
    journal,
    normalizer,
  });
  const broker = new PermissionBroker({ store, ports: bridge, events: bridge });
  scheduler.setPermissionBroker(broker);
  const controller = new ManagedRunController({
    scheduler,
    sessions,
    normalizer,
    permissionBroker: broker,
  });
  return {
    controller,
    scheduler,
    sessions,
    journal,
    broker,
    store,
    workspaceId: 'ws_live',
    cwd,
    settingsBefore,
  };
}

async function sendPrompt(
  harness: LiveHarness,
  sessionId: string,
  text: string,
  commandId: string,
): Promise<string> {
  const accepted = await harness.controller.sendPrompt(
    sessionId,
    text,
    commandId,
    `trace_${commandId}`,
    'device_live',
  );
  return accepted.runId;
}

describe('S03 real SDK approval regression', () => {
  it(
    'allows a fixed Bash once, re-approves the next request and keeps settings unchanged',
    async () => {
      const harness = await buildHarness();
      try {
        const session = harness.sessions.create({
          workspaceId: harness.workspaceId,
        });
        const marker = join(harness.cwd, 's03-marker.txt');
        const prompt = [
          'Use the Bash tool to run exactly this command:',
          `printf 'S03_LIVE_ALPHA\\n' >> ${marker}`,
          'Then reply DONE.',
        ].join(' ');

        const firstRun = await sendPrompt(harness, session.sessionId, prompt, 'cmd_live_1');
        const [firstPending] = await waitForPending(harness, 1);
        if (firstPending === undefined) throw new Error('no pending approval');
        respond(harness, firstPending, 'allow_once');
        expect(await waitForTerminal(harness, session.sessionId, firstRun)).toBe(
          'succeeded',
        );
        expect((await readFile(marker, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);

        const secondRun = await sendPrompt(harness, session.sessionId, prompt, 'cmd_live_2');
        await waitFor(
          () => pendingApprovals(harness).length >= 1,
          'second approval',
        );
        const secondPending = pendingApprovals(harness);
        const visible = secondPending.find(
          (approval) => approval.runId === secondRun,
        );
        if (visible === undefined) throw new Error('second approval missing');
        expect(visible.approvalId).not.toBe(firstPending.approvalId);
        respond(harness, visible, 'allow_once');
        expect(await waitForTerminal(harness, session.sessionId, secondRun)).toBe(
          'succeeded',
        );
        expect((await readFile(marker, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2);

        const settingsAfter = await readFile(
          join(harness.cwd, '.claude', 'settings.local.json'),
          'utf8',
        );
        expect(settingsAfter).toBe(harness.settingsBefore);
      } finally {
        await rm(harness.cwd, { recursive: true, force: true });
      }
    },
    600_000,
  );

  it(
    'denies a Bash without executing it and still ends the run from the SDK result',
    async () => {
      const harness = await buildHarness();
      try {
        const session = harness.sessions.create({
          workspaceId: harness.workspaceId,
        });
        const marker = join(harness.cwd, 's03-denied.txt');
        const runId = await sendPrompt(
          harness,
          session.sessionId,
          [
            'Use the Bash tool to run exactly this command:',
            `touch ${marker}`,
            'Then reply DONE.',
          ].join(' '),
          'cmd_live_deny',
        );
        const [pending] = await waitForPending(harness, 1);
        if (pending === undefined) throw new Error('no pending approval');
        respond(harness, pending, 'deny');

        expect(await waitForTerminal(harness, session.sessionId, runId)).toBe(
          'succeeded',
        );
        await expect(readFile(marker)).rejects.toThrow();
      } finally {
        await rm(harness.cwd, { recursive: true, force: true });
      }
    },
    600_000,
  );

  it(
    'expires an untouched approval after 120 seconds without cancelling the run',
    async () => {
      const harness = await buildHarness();
      try {
        const session = harness.sessions.create({
          workspaceId: harness.workspaceId,
        });
        const marker = join(harness.cwd, 's03-expired.txt');
        const runId = await sendPrompt(
          harness,
          session.sessionId,
          [
            'Use the Bash tool to run exactly this command:',
            `touch ${marker}`,
            'Then reply DONE.',
          ].join(' '),
          'cmd_live_expire',
        );
        const [pending] = await waitForPending(harness, 1);
        if (pending === undefined) throw new Error('no pending approval');

        await waitFor(
          () =>
            harness.store.getById(pending.approvalId)?.status === 'expired',
          'approval expiry',
          130_000,
        );
        expect(harness.sessions.get(session.sessionId).runsById.get(runId)?.status)
          .not.toBe('cancelled');
        await expect(readFile(marker)).rejects.toThrow();
        const resolved = harness.journal
          .recent(session.sessionId, 500)
          .filter(
            (event) =>
              event.type === 'permission.resolved' &&
              event.approvalId === pending.approvalId,
          );
        expect(resolved).toHaveLength(1);
      } finally {
        await rm(harness.cwd, { recursive: true, force: true });
      }
    },
    600_000,
  );

  it(
    'keeps two sessions pending independently',
    async () => {
      const harness = await buildHarness();
      try {
        const first = harness.sessions.create({ workspaceId: harness.workspaceId });
        const second = harness.sessions.create({ workspaceId: harness.workspaceId });
        const firstRun = await sendPrompt(
          harness,
          first.sessionId,
          'Use the Bash tool to run exactly: echo S03_LIVE_A. Then reply DONE.',
          'cmd_live_a',
        );
        const secondRun = await sendPrompt(
          harness,
          second.sessionId,
          'Use the Bash tool to run exactly: echo S03_LIVE_B. Then reply DONE.',
          'cmd_live_b',
        );
        const pending = await waitForPending(harness, 2);
        const pendingA = pending.find((entry) => entry.sessionId === first.sessionId);
        const pendingB = pending.find((entry) => entry.sessionId === second.sessionId);
        if (pendingA === undefined || pendingB === undefined) {
          throw new Error('both sessions must be pending');
        }
        expect(pendingA.approvalId).not.toBe(pendingB.approvalId);

        respond(harness, pendingA, 'allow_once');
        respond(harness, pendingB, 'deny');

        expect(await waitForTerminal(harness, first.sessionId, firstRun)).toBe(
          'succeeded',
        );
        expect(await waitForTerminal(harness, second.sessionId, secondRun)).toBe(
          'succeeded',
        );
      } finally {
        await rm(harness.cwd, { recursive: true, force: true });
      }
    },
    600_000,
  );
});