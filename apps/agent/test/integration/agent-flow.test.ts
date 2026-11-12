import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { MockManagedRunDriver } from '../../src/adapter/mock-managed-run-driver.js';
import { AdminClient } from '../../src/admin/client.js';
import { createAgentRuntime, AgentRuntime } from '../../src/app/runtime.js';
import { AgentLogger } from '../../src/app/logger.js';
import { initializeConfig } from '../../src/config/initialize.js';
import { AgentConfig } from '../../src/domain/types.js';

interface Message {
  type: string;
  commandId?: string;
  eventId?: string;
  seq?: number;
  payload: Record<string, unknown>;
}

class WsClient {
  readonly messages: Message[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as Message);
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(
    predicate: (message: Message) => boolean,
    timeoutMs: number = 3000,
  ): Promise<Message> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = this.messages.find(predicate);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `timed out waiting for message; saw ${JSON.stringify(this.messages.map((m) => m.type))}`,
    );
  }

  close(): void {
    this.socket.terminate();
  }
}

const silentLogger: AgentLogger = {
  info: () => undefined,
  warn: () => undefined,
};

interface Harness {
  runtime: AgentRuntime;
  config: AgentConfig;
  configDir: string;
  driver: MockManagedRunDriver;
  admin: AdminClient;
}

async function startRuntime(): Promise<Harness> {
  const configDir = await mkdtemp(join(tmpdir(), 's01-runtime-'));
  const workspace = await mkdtemp(join(tmpdir(), 's01-workspace-'));
  const config = await initializeConfig({
    configDir,
    workspacePath: workspace,
    displayName: 'S01 Fixture',
    tailscaleBaseUrl: 'https://macbook.example-tailnet.ts.net',
  });
  const driver = new MockManagedRunDriver();
  const runtime = await createAgentRuntime(config, driver, {
    configDir,
    phoneListen: { host: '127.0.0.1', port: 0 },
    logger: silentLogger,
  });
  await runtime.start();
  return {
    runtime,
    config,
    configDir,
    driver,
    admin: new AdminClient(join(configDir, 'agent.sock')),
  };
}

async function pairDevice(
  harness: Harness,
): Promise<{ deviceId: string; deviceToken: string; port: number }> {
  const payload = await harness.admin.pair();
  const address = harness.runtime.address();
  if (address === null) throw new Error('runtime is not listening');
  const response = await fetch(
    `http://127.0.0.1:${address.port}/v1/pairings`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingId: payload.pairingId,
        code: payload.code,
        deviceName: 'iPhone',
        appVersion: '0.1.0',
        supportedProtocolVersions: [1],
      }),
    },
  );
  const body = (await response.json()) as {
    deviceId: string;
    deviceToken: string;
  };
  return { ...body, port: address.port };
}

async function connect(
  device: { deviceId: string; deviceToken: string; port: number },
): Promise<WsClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${device.port}/ws`, {
    headers: {
      authorization: `Bearer ${device.deviceId}.${device.deviceToken}`,
    },
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  const client = new WsClient(socket);
  client.send({
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
  });
  await client.waitFor((message) => message.type === 'connection.ready');
  return client;
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

const running = new Set<Harness>();

afterEach(async () => {
  for (const harness of running) await harness.runtime.close();
  running.clear();
});

describe('agent runtime integration', () => {
  it('runs the full pair, prompt, busy, cancel and snapshot flow', async () => {
    const harness = await startRuntime();
    running.add(harness);
    const device = await pairDevice(harness);
    const client = await connect(device);

    client.send(
      command('session.start', 'cmd_1', {
        workspaceId: 'default',
        clientCapabilities: ['text'],
      }),
    );
    const started = await client.waitFor(
      (message) => message.commandId === 'cmd_1',
    );
    const sessionId = (started.payload['data'] as { sessionId: string })
      .sessionId;

    client.send(
      command('prompt.send', 'cmd_2', { text: 'hello' }, { sessionId }),
    );
    const accepted = await client.waitFor(
      (message) => message.commandId === 'cmd_2',
    );
    const runId = (accepted.payload['data'] as { runId: string }).runId;

    client.send(
      command('prompt.send', 'cmd_3', { text: 'busy' }, { sessionId }),
    );
    const busy = await client.waitFor(
      (message) => message.commandId === 'cmd_3',
    );
    expect(busy.payload).toMatchObject({
      status: 'ok',
      data: { status: 'queued' },
    });

    harness.driver.emit(runId, {
      kind: 'textDelta',
      sessionId,
      runId,
      assistantMessageId: 'msg_1',
      contentBlockIndex: 0,
      text: 'hi there',
    });
    const delta = await client.waitFor(
      (message) => message.type === 'message.delta',
    );
    expect(delta.payload).toMatchObject({ text: 'hi there' });

    client.send(
      command('run.cancel', 'cmd_4', {}, { sessionId, runId }),
    );
    const cancelling = await client.waitFor(
      (message) => message.commandId === 'cmd_4',
    );
    expect(cancelling.payload).toMatchObject({
      status: 'ok',
      data: { status: 'cancelling' },
    });

    harness.driver.emit(runId, {
      kind: 'runResult',
      sessionId,
      runId,
      status: 'cancelled',
    });
    const completed = await client.waitFor(
      (message) => message.type === 'run.completed',
    );
    expect(completed.payload).toMatchObject({ status: 'cancelled' });

    client.close();
    const reconnected = await connect(device);
    reconnected.send(
      command('session.snapshot', 'cmd_5', {}, { sessionId }),
    );
    const snapshot = await reconnected.waitFor(
      (message) => message.type === 'session.snapshot',
    );
    expect(snapshot.payload).toMatchObject({ lastSeq: expect.any(Number) });
    reconnected.close();
  });
});