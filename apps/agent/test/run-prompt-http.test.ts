import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PairingService } from '../src/pairing/pairing-service.js';
import { PROMPT_TTL_MS } from '../src/run/prompt-admission.js';
import { RunPromptController } from '../src/run/run-prompt-controller.js';
import { sha256Base64Url } from '../src/security/random.js';
import { AgentDatabase } from '../src/storage/database.js';
import { RunRepository, StoredRun } from '../src/storage/repositories/run-repository.js';
import { SessionRepository } from '../src/storage/repositories/session-repository.js';
import { DeviceStore } from '../src/store/device-store.js';
import { createPhoneServer } from '../src/transport/phone-server.js';

const NOW = 1_762_432_800_000;

async function setup() {
  const configDir = mkdtempSync(join(tmpdir(), 's04-prompt-http-'));
  const db = AgentDatabase.open(join(configDir, 'agent.sqlite3'));
  const sessions = new SessionRepository(db.uow);
  const runs = new RunRepository(db.uow);
  db.immediate((tx) => {
    tx.prepare(
      "INSERT INTO workspaces (workspaceId, displayName, rootPath, createdAt) VALUES ('ws_1','W','/tmp/ws_1',1)",
    ).run();
    sessions.create({
      sessionId: 's1',
      workspaceId: 'ws_1',
      claudeSessionId: null,
      title: 'One',
      lifecycle: 'active',
      status: 'idle',
      lastSeq: 0,
      retentionFloor: 0,
      createdAt: 1,
      lastActivityAt: 1,
      archivedAt: null,
    });
  });
  const run = (runId: string, overrides: Partial<StoredRun> = {}): void => {
    runs.insert({
      runId,
      sessionId: 's1',
      workspaceId: 'ws_1',
      deviceId: 'device_1',
      commandId: `cmd_${runId}`,
      traceId: `trace_${runId}`,
      status: 'recovery_required',
      promptText: 'S04_PROMPT_BODY',
      promptExpiresAt: NOW + PROMPT_TTL_MS,
      enqueueOrder: 1,
      recoveryGeneration: 1,
      pendingApprovalCount: 0,
      outcomeUnknown: false,
      eventTailMayBeIncomplete: false,
      recoveryReason: 'agent_shutdown',
      enqueuedAt: NOW,
      startedAt: null,
      endedAt: null,
      errorSummary: null,
      ...overrides,
    });
  };
  run('run_1');
  run('run_hidden', { deviceId: 'device_other' });
  run('run_empty', { promptText: null });

  const deviceStore = new DeviceStore(configDir);
  await deviceStore.create('device_1', 'iPhone', sha256Base64Url('token-1'));
  const pairing = new PairingService({
    deviceStore,
    desktopId: 'desktop_1',
    baseUrl: 'https://mac.example-tailnet.ts.net',
  });
  const server = await createPhoneServer({
    pairingService: pairing,
    deviceStore,
    workspace: { workspaceId: 'ws_1', displayName: 'W' },
    onConnection: () => undefined,
    runPrompt: new RunPromptController({ runs, devices: deviceStore }),
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind');
  }
  const base = `http://127.0.0.1:${address.port}`;
  return { db, server, base, deviceStore };
}

function auth(deviceId = 'device_1', token = 'token-1'): Record<string, string> {
  return { authorization: `Bearer ${deviceId}.${token}` };
}

describe('GET /v1/runs/:runId/prompt', () => {
  it('returns the prompt with no-store for the originating active device', async () => {
    const context = await setup();
    try {
      const response = await fetch(`${context.base}/v1/runs/run_1/prompt`, {
        headers: auth(),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        runId: 'run_1',
        text: 'S04_PROMPT_BODY',
      });
      // 读取不占 seq、不写 command/event。
      expect(
        context.db.connection.prepare('SELECT count(*) AS total FROM events').get(),
      ).toEqual({ total: 0 });
      expect(
        context.db.connection
          .prepare('SELECT count(*) AS total FROM commands')
          .get(),
      ).toEqual({ total: 0 });
    } finally {
      await context.server.close();
      context.db.close();
    }
  });

  it('rejects unauthenticated, foreign, revoked, unknown and empty prompts', async () => {
    const context = await setup();
    try {
      const url = `${context.base}/v1/runs/run_1/prompt`;
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: auth('device_1', 'wrong') })).status).toBe(
        401,
      );
      expect(
        (await fetch(`${context.base}/v1/runs/run_hidden/prompt`, { headers: auth() }))
          .status,
      ).toBe(403);
      expect(
        (await fetch(`${context.base}/v1/runs/run_missing/prompt`, { headers: auth() }))
          .status,
      ).toBe(404);
      expect(
        (await fetch(`${context.base}/v1/runs/run_empty/prompt`, { headers: auth() }))
          .status,
      ).toBe(404);

      await context.deviceStore.revoke('device_1');
      expect((await fetch(url, { headers: auth() })).status).toBe(401);
    } finally {
      await context.server.close();
      context.db.close();
    }
  });
});