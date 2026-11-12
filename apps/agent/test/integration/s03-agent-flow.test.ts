import { mkdtemp, realpath } from 'node:fs/promises';
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

interface Message {
  type: string;
  commandId?: string;
  sessionId?: string;
  runId?: string;
  approvalId?: string;
  payload: Record<string, unknown>;
}

/** 每次 run 都主动请求一次 Bash 审批，再按结果结束。 */
class PermissionDriver implements ManagedRunDriver {
  readonly requests: Array<{ runId: string; approvalId: string | null }> = [];

  startRun(input: ManagedRunStart): ManagedRunHandle {
    void this.run(input);
    return {
      interrupt: async () => {
        input.onEvent({
          kind: 'runResult',
          sessionId: input.sessionId,
          runId: input.runId,
          status: 'cancelled',
        });
      },
      close: async () => undefined,
      resumeEvents: () => undefined,
    };
  }

  private async run(input: ManagedRunStart): Promise<void> {
    const result = await input.permissionBroker.request(input.runId, {
      toolName: 'Bash',
      input: { command: 'echo S03_FLOW', description: 'integration' },
      signal: new AbortController().signal,
      toolUseID: `toolu_${input.runId}`,
      requestId: `req_${input.runId}`,
    });
    if (result.behavior === 'allow') {
      input.onEvent({
        kind: 'toolStarted',
        sessionId: input.sessionId,
        runId: input.runId,
        toolUseId: `toolu_${input.runId}`,
        toolName: 'Bash',
        input: { command: 'echo S03_FLOW' },
      });
      input.onEvent({
        kind: 'toolCompleted',
        sessionId: input.sessionId,
        runId: input.runId,
        toolUseId: `toolu_${input.runId}`,
        status: 'succeeded',
        isError: false,
        summary: 'S03_FLOW',
      });
    }
    input.onEvent({
      kind: 'runResult',
      sessionId: input.sessionId,
      runId: input.runId,
      status: 'succeeded',
    });
  }
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

interface Harness {
  runtime: AgentRuntime;
  configDir: string;
  workspaceDir: string;
  driver: PermissionDriver;
  admin: AdminClient;
  workspaceId: string;
  port: number;
  device: { deviceId: string; deviceToken: string };
}

async function startHarness(approvalMode: 'deny' | 'allow_once'): Promise<Harness> {
  const configDir = await mkdtemp(join(tmpdir(), 's03-flow-'));
  const workspaceDir = await mkdtemp(join(tmpdir(), 's03-flow-ws-'));
  const config = await initializeConfig({
    configDir,
    workspacePath: workspaceDir,
    displayName: 'S03 Fixture',
    tailscaleBaseUrl: 'https://macbook.example-tailnet.ts.net',
  });
  const driver = new PermissionDriver();
  const runtime = await createAgentRuntime(config, driver, {
    configDir,
    phoneListen: { host: '127.0.0.1', port: 0 },
    logger: silentLogger,
  });
  await runtime.start();
  runtimes.push(runtime);
  const admin = new AdminClient(join(configDir, 'agent.sock'));
  const workspaceId = config.workspace.workspaceId;
  await admin.workspaceSetApproval(workspaceId, approvalMode);
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
    workspaceId,
    port: address.port,
    device: paired,
  };
}

async function connect(
  harness: Harness,
): Promise<{ socket: WebSocket; messages: Message[] }> {
  const messages: Message[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`, {
    headers: {
      authorization: `Bearer ${harness.device.deviceId}.${harness.device.deviceToken}`,
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
        deviceId: harness.device.deviceId,
        capabilities: ['text'],
        handshakeId: 'handshake_1',
      },
    }),
  );
  await waitFor(messages, (message) => message.type === 'connection.ready');
  return { socket, messages };
}

function authHeader(harness: Harness): Record<string, string> {
  return {
    authorization: `Bearer ${harness.device.deviceId}.${harness.device.deviceToken}`,
  };
}

function contentUrl(harness: Harness, approvalId: string): string {
  return `http://127.0.0.1:${harness.port}/v1/approvals/${approvalId}/content?chunkIndex=0`;
}

describe('S03 agent approval flow', () => {
  it('serves content and completes an allow_once turn', async () => {
    const harness = await startHarness('allow_once');
    const { socket, messages } = await connect(harness);
    socket.send(
      JSON.stringify(
        command('session.create', 'cmd_create', {
          workspaceId: harness.workspaceId,
        }),
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
    const requested = await waitFor(
      messages,
      (message) => message.type === 'permission.requested',
      5_000,
      'permission.requested',
    );
    const approvalId = requested.approvalId;
    const runId = requested.runId;
    if (approvalId === undefined || runId === undefined) {
      throw new Error('approval event misses ids');
    }

    const contentResponse = await fetch(contentUrl(harness, approvalId), {
      headers: authHeader(harness),
    });
    expect(contentResponse.status).toBe(200);
    expect(contentResponse.headers.get('cache-control')).toBe('no-store');
    const body = (await contentResponse.json()) as {
      approvalId: string;
      text: string;
    };
    expect(body.approvalId).toBe(approvalId);
    expect(JSON.parse(body.text)).toMatchObject({
      toolName: 'Bash',
      workingDirectory: await realpath(harness.workspaceDir),
      input: { command: 'echo S03_FLOW' },
    });

    socket.send(
      JSON.stringify(
        command(
          'permission.respond',
          'cmd_allow',
          { decision: 'allow_once' },
          {
            workspaceId: harness.workspaceId,
            sessionId,
            runId,
            approvalId,
          },
        ),
      ),
    );
    const response = await waitFor(messages, (m) => m.commandId === 'cmd_allow');
    expect(response.payload).toMatchObject({
      status: 'ok',
      data: { approvalId, status: 'approved_once' },
    });

    const resolved = await waitFor(
      messages,
      (message) =>
        message.type === 'permission.resolved' &&
        message.approvalId === approvalId,
      5_000,
      'permission.resolved',
    );
    expect(resolved.payload).toMatchObject({
      status: 'approved_once',
      resolutionReason: 'user_allow_once',
      responseCommandId: 'cmd_allow',
    });

    const completed = await waitFor(
      messages,
      (message) =>
        message.type === 'tool.completed' &&
        (message.payload as { status?: string }).status === 'succeeded',
      5_000,
      'tool.completed',
    );
    expect(completed.payload).toMatchObject({ toolUseId: `toolu_${runId}` });
    await waitFor(
      messages,
      (message) => message.type === 'run.completed' && message.runId === runId,
      5_000,
      'run.completed',
    );

    const secondRead = await fetch(contentUrl(harness, approvalId), {
      headers: authHeader(harness),
    });
    expect(secondRead.status).toBe(409);
    socket.terminate();
  });

  it('denies without executing and keeps two sessions isolated', async () => {
    const harness = await startHarness('allow_once');
    const { socket, messages } = await connect(harness);
    const createSession = async (commandId: string): Promise<string> => {
      socket.send(
        JSON.stringify(
          command('session.create', commandId, {
            workspaceId: harness.workspaceId,
          }),
        ),
      );
      return (
        (await waitFor(messages, (m) => m.commandId === commandId)).payload[
          'data'
        ] as { sessionId: string }
      ).sessionId;
    };
    const sessionA = await createSession('cmd_create_a');
    const sessionB = await createSession('cmd_create_b');

    socket.send(
      JSON.stringify(
        command('prompt.send', 'cmd_a', { text: 'a' }, { sessionId: sessionA }),
      ),
    );
    socket.send(
      JSON.stringify(
        command('prompt.send', 'cmd_b', { text: 'b' }, { sessionId: sessionB }),
      ),
    );
    await waitFor(
      messages,
      (message) =>
        message.type === 'permission.requested' && message.sessionId === sessionA,
      5_000,
      'pending A',
    );
    await waitFor(
      messages,
      (message) =>
        message.type === 'permission.requested' && message.sessionId === sessionB,
      5_000,
      'pending B',
    );
    const requestedA = messages.find(
      (message) =>
        message.type === 'permission.requested' && message.sessionId === sessionA,
    );
    const requestedB = messages.find(
      (message) =>
        message.type === 'permission.requested' && message.sessionId === sessionB,
    );
    if (
      requestedA?.approvalId === undefined ||
      requestedB?.approvalId === undefined ||
      requestedA.runId === undefined ||
      requestedB.runId === undefined
    ) {
      throw new Error('approval ids missing');
    }

    socket.send(
      JSON.stringify(
        command(
          'permission.respond',
          'cmd_deny_a',
          { decision: 'deny' },
          {
            workspaceId: harness.workspaceId,
            sessionId: sessionA,
            runId: requestedA.runId,
            approvalId: requestedA.approvalId,
          },
        ),
      ),
    );
    await waitFor(messages, (m) => m.commandId === 'cmd_deny_a');
    const denied = await waitFor(
      messages,
      (message) =>
        message.type === 'permission.resolved' &&
        message.approvalId === requestedA.approvalId,
      5_000,
      'denied resolved',
    );
    expect(denied.payload).toMatchObject({
      status: 'denied',
      resolutionReason: 'user_deny',
    });
    expect(
      messages.some(
        (message) =>
          message.type === 'permission.resolved' &&
          message.approvalId === requestedB.approvalId,
      ),
    ).toBe(false);

    const contentB = await (
      await fetch(contentUrl(harness, requestedB.approvalId), {
        headers: authHeader(harness),
      })
    ).json();
    expect(contentB).toMatchObject({ approvalId: requestedB.approvalId });

    socket.send(
      JSON.stringify(
        command(
          'permission.respond',
          'cmd_allow_b',
          { decision: 'allow_once' },
          {
            workspaceId: harness.workspaceId,
            sessionId: sessionB,
            runId: requestedB.runId,
            approvalId: requestedB.approvalId,
          },
        ),
      ),
    );
    await waitFor(messages, (m) => m.commandId === 'cmd_allow_b');
    socket.terminate();
  });

  it('denies every tool when the workspace stays at deny', async () => {
    const harness = await startHarness('deny');
    const { socket, messages } = await connect(harness);
    socket.send(
      JSON.stringify(
        command('session.create', 'cmd_create', {
          workspaceId: harness.workspaceId,
        }),
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

    await waitFor(
      messages,
      (message) =>
        message.type === 'error' &&
        (message.payload as { code?: string }).code === 'PERMISSION_REQUIRED',
      5_000,
      'PERMISSION_REQUIRED',
    );
    expect(
      messages.some((message) => message.type === 'permission.requested'),
    ).toBe(false);
    socket.terminate();
  });
});