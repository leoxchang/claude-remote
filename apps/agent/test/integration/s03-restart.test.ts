import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  ManagedRunDriver,
  ManagedRunHandle,
  ManagedRunStart,
} from '../../src/adapter/managed-run-driver.js';
import { AdminClient } from '../../src/admin/client.js';
import { AgentLogger } from '../../src/app/logger.js';
import { AgentRuntime, createAgentRuntime } from '../../src/app/runtime.js';
import { initializeConfig } from '../../src/config/initialize.js';

const silentLogger: AgentLogger = {
  info: () => undefined,
  warn: () => undefined,
};

class PendingDriver implements ManagedRunDriver {
  startRun(input: ManagedRunStart): ManagedRunHandle {
    void input.permissionBroker.request(input.runId, {
      toolName: 'Bash',
      input: { command: 'echo S03_RESTART' },
      signal: new AbortController().signal,
      toolUseID: `toolu_${input.runId}`,
      requestId: `req_${input.runId}`,
    });
    return {
      interrupt: async () => undefined,
      close: async () => undefined,
      resumeEvents: () => undefined,
    };
  }
}

interface Message {
  type: string;
  commandId?: string;
  sessionId?: string;
  runId?: string;
  approvalId?: string;
  payload: Record<string, unknown>;
}

async function waitFor(
  messages: Message[],
  predicate: (message: Message) => boolean,
  timeoutMs = 3_000,
  label = 'message',
): Promise<Message> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = messages.find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function command(
  type: string,
  commandId: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    messageId: `msg_${commandId}`,
    commandId,
    traceId: `trace_${commandId}`,
    timestamp: Date.now(),
    type,
    payload,
    ...extra,
  };
}

const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

describe('S03 restart boundaries', () => {
  it('invalidates pending approvals on shutdown and never restores them', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 's03-restart-'));
    const workspaceDir = await mkdtemp(join(tmpdir(), 's03-restart-ws-'));
    const config = await initializeConfig({
      configDir,
      workspacePath: workspaceDir,
      displayName: 'S03 Restart',
      tailscaleBaseUrl: 'https://macbook.example-tailnet.ts.net',
    });
    const runtime = await createAgentRuntime(config, new PendingDriver(), {
      configDir,
      phoneListen: { host: '127.0.0.1', port: 0 },
      logger: silentLogger,
    });
    await runtime.start();
    runtimes.push(runtime);
    const admin = new AdminClient(join(configDir, 'agent.sock'));
    await admin.workspaceSetApproval(config.workspace.workspaceId, 'allow_once');
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
    const auth = {
      authorization: `Bearer ${paired.deviceId}.${paired.deviceToken}`,
    };

    const messages: Message[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: auth,
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
        command('session.create', 'cmd_create', {
          workspaceId: config.workspace.workspaceId,
        }),
      ),
    );
    const sessionId = (
      (await waitFor(messages, (m) => m.commandId === 'cmd_create')).payload[
        'data'
      ] as { sessionId: string }
    ).sessionId;
    socket.send(
      JSON.stringify(
        command('prompt.send', 'cmd_prompt', { text: 'hello' }, { sessionId }),
      ),
    );
    const requested = await waitFor(
      messages,
      (message) => message.type === 'permission.requested',
      5_000,
      'permission.requested',
    );
    const approvalId = requested.approvalId;
    if (approvalId === undefined) throw new Error('approvalId missing');

    await runtime.close();

    const shutdown = await waitFor(
      messages,
      (message) => message.type === 'permission.resolved',
      3_000,
      'shutdown resolved',
    );
    expect(shutdown.payload).toMatchObject({
      status: 'invalidated',
      resolutionReason: 'agent_shutdown',
    });
    socket.terminate();

    const restarted = await createAgentRuntime(config, new PendingDriver(), {
      configDir,
      phoneListen: { host: '127.0.0.1', port: 0 },
      logger: silentLogger,
    });
    await restarted.start();
    runtimes.push(restarted);
    const restartedAddress = restarted.address();
    if (restartedAddress === null) throw new Error('restarted not listening');

    const oldContent = await fetch(
      `http://127.0.0.1:${restartedAddress.port}/v1/approvals/${approvalId}/content?chunkIndex=0`,
      { headers: auth },
    );
    expect(oldContent.status).toBe(404);
    expect((await oldContent.json()) as Record<string, unknown>).toMatchObject({
      error: { code: 'APPROVAL_NOT_FOUND' },
    });

    const list = (await admin.workspaceList()) as Array<{
      workspaceId: string;
      mobileApprovalMode: string;
    }>;
    expect(list[0]?.mobileApprovalMode).toBe('allow_once');
  });
});