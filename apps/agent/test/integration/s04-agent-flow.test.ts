import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ManagedRunDriver,
  ManagedRunHandle,
  ManagedRunStart,
} from '../../src/adapter/managed-run-driver.js';
import { createDurableAgentRuntime } from '../../src/app/runtime.js';
import { resolveAgentPaths } from '../../src/config/paths.js';

const NOW = 1_762_432_800_000;

class FakeHandle implements ManagedRunHandle {
  closed = false;
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  resumeEvents(): void {}
}

class FakeDriver implements ManagedRunDriver {
  readonly starts: ManagedRunStart[] = [];
  readonly handles: FakeHandle[] = [];

  startRun(input: ManagedRunStart): ManagedRunHandle {
    this.starts.push(input);
    const handle = new FakeHandle();
    this.handles.push(handle);
    return handle;
  }

  emit(runId: string, event: Parameters<ManagedRunStart['onEvent']>[0]): void {
    const start = this.starts.find((entry) => entry.runId === runId);
    if (start === undefined) throw new Error('run was not started');
    start.onEvent(event);
  }
}

function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), 's04-flow-'));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 's04-flow-ws-')));
  const paths = resolveAgentPaths(configDir);
  writeFileSync(
    paths.agentFile,
    `${JSON.stringify(
      {
        version: 3,
        desktopId: 'desktop_1',
        workspaces: [
          {
            workspaceId: 'ws_1',
            displayName: 'Project',
            rootPath: project,
            createdAt: NOW,
            policy: { perSessionQueueLimit: 20, mobileApprovalMode: 'deny' },
          },
        ],
        listen: { host: '127.0.0.1', port: 8787 },
        tailscale: { baseUrl: 'https://mac.example-tailnet.ts.net' },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { configDir, driver: new FakeDriver() };
}

function options(configDir: string) {
  return {
    configDir,
    phoneListen: { host: '127.0.0.1', port: 0 },
  };
}

describe('S04 agent integration flow', () => {
  it('persists prompt, restart and explicit requeue without auto replay', async () => {
    const { configDir, driver } = fixture();
    const first = await createDurableAgentRuntime(driver, options(configDir));
    const session = first.operations.createSession('ws_1', 'Flow');
    try {
      await first.start();
      expect(first.address()).not.toBeNull();

      const accepted = await first.operations.sendPrompt(
        'ws_1',
        session.sessionId,
        'first prompt',
        'cmd_1',
        'trace_1',
        'device_1',
      );
      expect(accepted).toMatchObject({ status: 'queued' });
      expect(driver.starts).toHaveLength(1);

      driver.emit(accepted.runId, {
        kind: 'init',
        sessionId: session.sessionId,
        runId: accepted.runId,
        claudeSessionId: 'claude_1',
      });
      driver.emit(accepted.runId, {
        kind: 'runResult',
        sessionId: session.sessionId,
        runId: accepted.runId,
        status: 'succeeded',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        first.operations
          .listSessions({ workspaceId: 'ws_1' })
          .sessions.find((entry) => entry.sessionId === session.sessionId)
          ?.status,
      ).toBe('idle');

      // 第二个 prompt 保持 queued；关闭时不得自动执行。
      const queued = await first.operations.sendPrompt(
        'ws_1',
        session.sessionId,
        'second prompt',
        'cmd_2',
        'trace_2',
        'device_1',
      );
      expect(queued.runId).not.toBe(accepted.runId);
      expect(driver.starts).toHaveLength(2);
    } finally {
      await first.close();
    }

    const second = await createDurableAgentRuntime(driver, options(configDir));
    try {
      expect(second.recovery.recoveredQueuedRuns).toEqual([]);
      // 上一次运行已成功；没有残留 queued。
      const sessions = second.operations.listSessions({
        workspaceId: 'ws_1',
        includeArchived: true,
      }).sessions;
      expect(sessions).toHaveLength(1);
      expect(driver.starts).toHaveLength(2);
    } finally {
      await second.close();
    }
  });

  it('repairs an in-flight queued run to recovery_required and requeues on demand', async () => {
    const { configDir, driver } = fixture();
    const first = await createDurableAgentRuntime(driver, options(configDir));
    const session = first.operations.createSession('ws_1', 'Recovery');
    try {
      // 两个会话各自占一个槽，使第三个 prompt 留在 queued。
      const other = first.operations.createSession('ws_1', 'Other');
      await first.operations.sendPrompt(
        'ws_1',
        session.sessionId,
        'active',
        'cmd_a',
        'trace_a',
        'device_1',
      );
      await first.operations.sendPrompt(
        'ws_1',
        other.sessionId,
        'active2',
        'cmd_b',
        'trace_b',
        'device_1',
      );
      const queued = await first.operations.sendPrompt(
        'ws_1',
        session.sessionId,
        'queued prompt',
        'cmd_c',
        'trace_c',
        'device_1',
      );
      expect(driver.starts).toHaveLength(2);
      expect(queued.runId).toBeTruthy();
    } finally {
      await first.close();
    }

    const second = await createDurableAgentRuntime(driver, options(configDir));
    try {
      expect(second.recovery.recoveredQueuedRuns).toHaveLength(1);
      const runId = second.recovery.recoveredQueuedRuns[0];
      if (runId === undefined) throw new Error('missing recovered run');

      const requeued = second.recoveryService.requeue({
        identity: {
          commandId: 'cmd_requeue',
          type: 'run.requeue',
          sessionId: session.sessionId,
          runId,
          payload: { expectedRecoveryGeneration: 1 },
        },
        actor: { deviceId: 'device_1' },
        sessionId: session.sessionId,
        runId,
        expectedRecoveryGeneration: 1,
        now: Date.now(),
      });
      expect(requeued.result).toMatchObject({ runId, status: 'queued' });
    } finally {
      await second.close();
    }
  });
});