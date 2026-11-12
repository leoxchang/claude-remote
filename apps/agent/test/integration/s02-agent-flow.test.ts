import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { MockManagedRunDriver } from '../../src/adapter/mock-managed-run-driver.js';
import { AdminClient } from '../../src/admin/client.js';
import { AgentLogger } from '../../src/app/logger.js';
import { AgentRuntime, createAgentRuntime } from '../../src/app/runtime.js';
import { initializeConfig } from '../../src/config/initialize.js';

const silentLogger: AgentLogger = {
  info: () => undefined,
  warn: () => undefined,
};

interface Message {
  type: string;
  commandId?: string;
  payload: Record<string, unknown>;
}

async function waitFor(
  messages: Message[],
  predicate: (message: Message) => boolean,
  timeoutMs = 3_000,
): Promise<Message> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = messages.find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout; saw ${messages.map((m) => m.type).join(',')}`);
}

const command = (
  type: string,
  commandId: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  protocolVersion: 1,
  messageId: `msg_${commandId}`,
  commandId,
  traceId: `trace_${commandId}`,
  timestamp: Date.now(),
  type,
  payload,
  ...extra,
});

const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

interface Harness {
  runtime: AgentRuntime;
  configDir: string;
  workspaceDir: string;
  driver: MockManagedRunDriver;
  admin: AdminClient;
  device: { deviceId: string; deviceToken: string; port: number };
}

async function startHarness(): Promise<Harness> {
  const configDir = await mkdtemp(join(tmpdir(), 's02-flow-'));
  const workspaceDir = await mkdtemp(join(tmpdir(), 's02-flow-ws-'));
  const config = await initializeConfig({
    configDir,
    workspacePath: workspaceDir,
    displayName: 'S02 Fixture',
    tailscaleBaseUrl: 'https://macbook.example-tailnet.ts.net',
  });
  const driver = new MockManagedRunDriver();
  const runtime = await createAgentRuntime(config, driver, {
    configDir,
    phoneListen: { host: '127.0.0.1', port: 0 },
    logger: silentLogger,
  });
  await runtime.start();
  runtimes.push(runtime);
  const admin = new AdminClient(join(configDir, 'agent.sock'));
  const pairing = await admin.pair();
  const address = runtime.address();
  if (address === null) throw new Error('not listening');
  const paired = (await (
    await fetch(`http://127.0.0.1:${address.port}/v1/pairings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingId: pairing.pairingId,
        code: pairing.code,
        deviceName: 'iPhone',
        appVersion: '0.1.0',
        supportedProtocolVersions: [1],
      }),
    })
  ).json()) as { deviceId: string; deviceToken: string };
  return {
    runtime,
    configDir,
    workspaceDir,
    driver,
    admin,
    device: { ...paired, port: address.port },
  };
}

async function connect(
  device: { deviceId: string; deviceToken: string; port: number },
): Promise<{ socket: WebSocket; messages: Message[] }> {
  const messages: Message[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${device.port}/ws`, {
    headers: {
      authorization: `Bearer ${device.deviceId}.${device.deviceToken}`,
    },
  });
  socket.on('message', (data) => {
    messages.push(JSON.parse(String(data)) as Message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  socket.send(
    JSON.stringify({
      protocolVersion: 1,
      messageId: 'msg_hello',
      timestamp: Date.now(),
      type: 'connection.hello',
      payload: {
        supportedProtocolVersions: [1],
        appVersion: '0.1.0',
        deviceId: device.deviceId,
        capabilities: ['text'],
        handshakeId: 'handshake_1',
      },
    }),
  );
  await waitFor(messages, (message) => message.type === 'connection.ready');
  return { socket, messages };
}

describe('S02 agent flow', () => {
  it('runs two sessions concurrently and queues the third prompt', async () => {
    const harness = await startHarness();
    const { socket, messages } = await connect(harness.device);

    socket.send(
      JSON.stringify(command('workspace.list', 'cmd_ws', {})),
    );
    const workspaces = await waitFor(messages, (m) => m.commandId === 'cmd_ws');
    const workspaceId = (
      workspaces.payload['data'] as {
        workspaces: Array<{ workspaceId: string }>;
        scheduler: { maxActiveRuns: number };
      }
    ).workspaces[0]?.workspaceId;
    expect(workspaceId).toBe('default');
    expect(
      (workspaces.payload['data'] as { scheduler: { maxActiveRuns: number } })
        .scheduler.maxActiveRuns,
    ).toBe(2);

    socket.send(
      JSON.stringify(
        command('session.create', 'cmd_create_a', { workspaceId }),
      ),
    );
    const createdA = await waitFor(
      messages,
      (m) => m.commandId === 'cmd_create_a',
    );
    const sessionA = (createdA.payload['data'] as { sessionId: string })
      .sessionId;
    socket.send(
      JSON.stringify(
        command('session.create', 'cmd_create_b', { workspaceId }),
      ),
    );
    const createdB = await waitFor(
      messages,
      (m) => m.commandId === 'cmd_create_b',
    );
    const sessionB = (createdB.payload['data'] as { sessionId: string })
      .sessionId;
    expect(sessionA).not.toBe(sessionB);

    socket.send(
      JSON.stringify(
        command('prompt.send', 'cmd_a1', { text: 'a1' }, { sessionId: sessionA }),
      ),
    );
    const acceptedA = await waitFor(messages, (m) => m.commandId === 'cmd_a1');
    const runA = (acceptedA.payload['data'] as { runId: string }).runId;
    socket.send(
      JSON.stringify(
        command('prompt.send', 'cmd_b1', { text: 'b1' }, { sessionId: sessionB }),
      ),
    );
    const acceptedB = await waitFor(messages, (m) => m.commandId === 'cmd_b1');
    expect(acceptedB.payload).toMatchObject({
      status: 'ok',
      data: { status: 'starting' },
    });

    socket.send(
      JSON.stringify(
        command('prompt.send', 'cmd_a2', { text: 'a2' }, { sessionId: sessionA }),
      ),
    );
    const queuedA2 = await waitFor(messages, (m) => m.commandId === 'cmd_a2');
    const runA2 = (queuedA2.payload['data'] as { runId: string }).runId;
    expect(queuedA2.payload).toMatchObject({
      status: 'ok',
      data: { status: 'queued' },
    });

    socket.send(
      JSON.stringify(command('queue.remove', 'cmd_remove', {}, { sessionId: sessionA, runId: runA2 })),
    );
    const removed = await waitFor(
      messages,
      (m) => m.commandId === 'cmd_remove',
    );
    expect(removed.payload).toMatchObject({
      status: 'ok',
      data: { removed: true, status: 'cancelled' },
    });

    socket.send(
      JSON.stringify(command('session.list', 'cmd_list', { workspaceId })),
    );
    const listed = await waitFor(messages, (m) => m.commandId === 'cmd_list');
    const sessions = (listed.payload['data'] as {
      sessions: Array<{ sessionId: string; status: string; queuedCount: number }>;
    }).sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.status === 'running')).toBe(true);

    socket.send(
      JSON.stringify(command('session.snapshot', 'cmd_snap', {}, { sessionId: sessionA })),
    );
    const snapshot = await waitFor(messages, (m) => m.type === 'session.snapshot');
    expect((snapshot.payload as { session: { sessionId: string } }).session.sessionId).toBe(
      sessionA,
    );

    harness.driver.emit(runA, {
      kind: 'textDelta',
      sessionId: sessionA,
      runId: runA,
      assistantMessageId: 'm1',
      contentBlockIndex: 0,
      text: 'hello A',
    });
    const delta = await waitFor(messages, (m) => m.type === 'message.delta');
    expect((delta as unknown as { sessionId: string }).sessionId).toBe(sessionA);

    socket.terminate();
  });

  it('isolates snapshots and targets between sessions', async () => {
    const harness = await startHarness();
    const { socket, messages } = await connect(harness.device);

    socket.send(
      JSON.stringify(command('session.create', 'cmd_create_a', { workspaceId: 'default' })),
    );
    const sessionA = (
      (await waitFor(messages, (m) => m.commandId === 'cmd_create_a'))
        .payload['data'] as { sessionId: string }
    ).sessionId;
    socket.send(
      JSON.stringify(command('session.create', 'cmd_create_b', { workspaceId: 'default' })),
    );
    const sessionB = (
      (await waitFor(messages, (m) => m.commandId === 'cmd_create_b'))
        .payload['data'] as { sessionId: string }
    ).sessionId;

    socket.send(
      JSON.stringify(
        command('prompt.send', 'cmd_a1', { text: 'only-a' }, { sessionId: sessionA }),
      ),
    );
    const accepted = await waitFor(messages, (m) => m.commandId === 'cmd_a1');
    const runA = (accepted.payload['data'] as { runId: string }).runId;
    harness.driver.emit(runA, {
      kind: 'textDelta',
      sessionId: sessionA,
      runId: runA,
      assistantMessageId: 'm1',
      contentBlockIndex: 0,
      text: 'for A only',
    });
    await waitFor(messages, (m) => m.type === 'message.delta');

    socket.send(
      JSON.stringify(command('session.snapshot', 'cmd_snap_b', {}, { sessionId: sessionB })),
    );
    const snapshotB = await waitFor(messages, (m) =>
      m.type === 'session.snapshot' && typeof m.payload['lastSeq'] === 'number',
    );
    expect((snapshotB.payload as { recentEvents: unknown[] }).recentEvents).toEqual(
      [],
    );
    expect((snapshotB.payload as { session: { sessionId: string } }).session.sessionId).toBe(
      sessionB,
    );

    socket.terminate();
  });
});