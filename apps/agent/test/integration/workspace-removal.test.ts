import { mkdtemp, stat } from 'node:fs/promises';
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

describe('workspace removal', () => {
  it('refuses to remove a busy workspace and hides it afterwards', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 's02-remove-'));
    const workspaceDir = await mkdtemp(join(tmpdir(), 's02-remove-ws-'));
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

    const messages: Message[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: {
        authorization: `Bearer ${paired.deviceId}.${paired.deviceToken}`,
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
          deviceId: paired.deviceId,
          capabilities: ['text'],
          handshakeId: 'handshake_1',
        },
      }),
    );
    await waitFor(messages, (message) => message.type === 'connection.ready');

    socket.send(
      JSON.stringify(
        command('session.create', 'cmd_create', { workspaceId: 'default' }),
      ),
    );
    const sessionId = (
      (await waitFor(messages, (m) => m.commandId === 'cmd_create'))
        .payload['data'] as { sessionId: string }
    ).sessionId;
    socket.send(
      JSON.stringify(
        command('prompt.send', 'cmd_prompt', { text: 'hello' }, { sessionId }),
      ),
    );
    const accepted = await waitFor(messages, (m) => m.commandId === 'cmd_prompt');
    const runId = (accepted.payload['data'] as { runId: string }).runId;

    await expect(admin.workspaceRemove('default')).rejects.toMatchObject({
      code: 'WORKSPACE_BUSY',
    });

    driver.emit(runId, {
      kind: 'runResult',
      sessionId,
      runId,
      status: 'succeeded',
    });
    await waitFor(messages, (message) => message.type === 'run.completed');

    await admin.workspaceRemove('default');
    expect(await admin.workspaceList()).toEqual([]);

    socket.send(
      JSON.stringify(
        command('prompt.send', 'cmd_after', { text: 'hello again' }, { sessionId }),
      ),
    );
    const after = await waitFor(messages, (m) => m.commandId === 'cmd_after');
    expect(after.payload).toMatchObject({
      status: 'error',
      error: { code: 'WORKSPACE_NOT_ALLOWED' },
    });

    expect((await stat(workspaceDir)).isDirectory()).toBe(true);
    socket.terminate();
  });
});