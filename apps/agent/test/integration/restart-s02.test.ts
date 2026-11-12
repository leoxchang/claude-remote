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
): Promise<Message> {
  const started = Date.now();
  while (Date.now() - started < 3_000) {
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

async function connect(
  device: { deviceId: string; deviceToken: string },
  port: number,
): Promise<{ socket: WebSocket; messages: Message[] }> {
  const messages: Message[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
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

describe('agent restart in S02', () => {
  it('keeps the device bound, changes agentInstanceId and drops memory sessions', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 's02-restart-'));
    const workspaceDir = await mkdtemp(join(tmpdir(), 's02-restart-ws-'));
    const config = await initializeConfig({
      configDir,
      workspacePath: workspaceDir,
      displayName: 'S02 Fixture',
      tailscaleBaseUrl: 'https://macbook.example-tailnet.ts.net',
    });

    const first = await createAgentRuntime(config, new MockManagedRunDriver(), {
      configDir,
      phoneListen: { host: '127.0.0.1', port: 0 },
      logger: silentLogger,
    });
    runtimes.push(first);
    await first.start();
    const firstAddress = first.address();
    if (firstAddress === null) throw new Error('not listening');
    const admin = new AdminClient(join(configDir, 'agent.sock'));
    const pairing = await admin.pair();
    const paired = (await (
      await fetch(`http://127.0.0.1:${firstAddress.port}/v1/pairings`, {
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

    const firstClient = await connect(paired, firstAddress.port);
    const firstReady = firstClient.messages.find(
      (message) => message.type === 'connection.ready',
    );
    expect(firstReady?.payload['agentInstanceId']).toBe(first.agentInstanceId);

    firstClient.socket.send(
      JSON.stringify(
        command('session.create', 'cmd_create', { workspaceId: 'default' }),
      ),
    );
    const sessionId = (
      (await waitFor(firstClient.messages, (m) => m.commandId === 'cmd_create'))
        .payload['data'] as { sessionId: string }
    ).sessionId;
    firstClient.socket.terminate();
    await first.close();

    const second = await createAgentRuntime(config, new MockManagedRunDriver(), {
      configDir,
      phoneListen: { host: '127.0.0.1', port: 0 },
      logger: silentLogger,
    });
    runtimes.push(second);
    await second.start();
    const secondAddress = second.address();
    if (secondAddress === null) throw new Error('not listening');

    const secondClient = await connect(paired, secondAddress.port);
    const secondReady = secondClient.messages.find(
      (message) => message.type === 'connection.ready',
    );
    expect(secondReady?.payload['agentInstanceId']).toBe(second.agentInstanceId);
    expect(second.agentInstanceId).not.toBe(first.agentInstanceId);

    secondClient.socket.send(
      JSON.stringify(command('session.snapshot', 'cmd_snap', {}, { sessionId })),
    );
    const snapshot = await waitFor(
      secondClient.messages,
      (m) => m.commandId === 'cmd_snap',
    );
    expect(snapshot.payload).toMatchObject({
      status: 'error',
      error: { code: 'SESSION_NOT_FOUND' },
    });

    secondClient.socket.terminate();
  });
});