import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ManagedRunDriver,
  ManagedRunHandle,
  ManagedRunStart,
} from '../src/adapter/managed-run-driver.js';
import { AgentConfigV3 } from '../src/config/config-v3.js';
import { EventJournal } from '../src/events/journal.js';
import { AdapterEvent } from '../src/events/adapter-events.js';
import { EventNormalizer } from '../src/events/normalizer.js';
import { ManagedRunController } from '../src/run/run-controller.js';
import { RunScheduler } from '../src/run/run-scheduler.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';
import { denyAllPermissionGate } from './permission-gate-fakes.js';

const FIXED_NOW = 1_762_432_800_000;

let configDir: string;
let workspaceDir: string;

/** 记录 interrupt/close 顺序的可控驱动。 */
class RecordingDriver implements ManagedRunDriver {
  readonly order: string[] = [];
  interruptFails = false;
  private readonly handlers = new Map<string, (event: AdapterEvent) => void>();

  startRun(input: ManagedRunStart): ManagedRunHandle {
    this.handlers.set(input.runId, input.onEvent);
    return {
      interrupt: async () => {
        this.order.push(`interrupt:${input.runId}`);
        if (this.interruptFails) throw new Error('interrupt failed');
      },
      close: async () => {
        this.order.push(`close:${input.runId}`);
      },
      resumeEvents: () => undefined,
    };
  }

  emit(runId: string, event: AdapterEvent): void {
    this.handlers.get(runId)?.(event);
  }
}

interface Harness {
  controller: ManagedRunController;
  scheduler: RunScheduler;
  sessions: SessionRegistry;
  driver: RecordingDriver;
  invalidations: Array<{ runId: string; reason: string }>;
  workspaceId: string;
}

async function setup(): Promise<Harness> {
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
    writeConfig: () => undefined,
  });
  const sessions = new SessionRegistry({ now: () => FIXED_NOW });
  const journal = new EventJournal();
  const driver = new RecordingDriver();
  const invalidations: Array<{ runId: string; reason: string }> = [];
  const scheduler = new RunScheduler({
    sessions,
    workspaces,
    journal,
    driver,
    now: () => FIXED_NOW,
    permissionBroker: denyAllPermissionGate(),
  });
  const controller = new ManagedRunController({
    scheduler,
    sessions,
    normalizer: new EventNormalizer(journal),
    permissionBroker: {
      invalidateRun: (runId, reason) => {
        invalidations.push({ runId, reason });
        driver.order.push(`invalidate:${runId}:${reason}`);
        return 1;
      },
    },
    interruptTimeoutMs: 20,
  });
  return {
    controller,
    scheduler,
    sessions,
    driver,
    invalidations,
    workspaceId: 'ws_alpha',
  };
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 's03-controller-'));
  workspaceDir = join(configDir, 'fixture-alpha');
  await mkdir(workspaceDir);
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe('ManagedRunController approval ordering', () => {
  it('invalidates approvals before interrupt on cancel', async () => {
    const harness = await setup();
    const session = harness.sessions.create({
      workspaceId: harness.workspaceId,
    });
    const accepted = await harness.controller.sendPrompt(
      session.sessionId,
      'hello',
      'cmd_1',
      'trace_1',
      'device_1',
    );

    await harness.controller.cancel(session.sessionId, accepted.runId);

    expect(harness.invalidations).toEqual([
      { runId: accepted.runId, reason: 'run_cancelled' },
    ]);
    const invalidateIndex = harness.driver.order.findIndex((entry) =>
      entry.startsWith('invalidate:'),
    );
    const interruptIndex = harness.driver.order.findIndex((entry) =>
      entry.startsWith('interrupt:'),
    );
    expect(invalidateIndex).toBeGreaterThanOrEqual(0);
    expect(interruptIndex).toBeGreaterThan(invalidateIndex);
    expect(harness.sessions.get(session.sessionId).activeRun?.status).toBe(
      'cancelling',
    );
  });

  it('invalidates leftover approvals before a terminal SDK result', async () => {
    const harness = await setup();
    const session = harness.sessions.create({
      workspaceId: harness.workspaceId,
    });
    const accepted = await harness.controller.sendPrompt(
      session.sessionId,
      'hello',
      'cmd_1',
      'trace_1',
      'device_1',
    );

    harness.driver.emit(accepted.runId, {
      kind: 'runResult',
      sessionId: session.sessionId,
      runId: accepted.runId,
      status: 'succeeded',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.invalidations).toEqual([
      { runId: accepted.runId, reason: 'sdk_aborted' },
    ]);
    expect(harness.sessions.get(session.sessionId).runsById.get(accepted.runId))
      .toMatchObject({ status: 'succeeded', pendingApprovalCount: 0 });
  });

  it('invalidates on interrupt failure before writing interrupted', async () => {
    const harness = await setup();
    harness.driver.interruptFails = true;
    const session = harness.sessions.create({
      workspaceId: harness.workspaceId,
    });
    const accepted = await harness.controller.sendPrompt(
      session.sessionId,
      'hello',
      'cmd_1',
      'trace_1',
      'device_1',
    );

    await harness.controller.cancel(session.sessionId, accepted.runId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.invalidations).toEqual([
      { runId: accepted.runId, reason: 'run_cancelled' },
      { runId: accepted.runId, reason: 'sdk_aborted' },
    ]);
    expect(harness.sessions.get(session.sessionId).runsById.get(accepted.runId))
      .toMatchObject({ status: 'interrupted' });
  });
});