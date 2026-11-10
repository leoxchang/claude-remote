import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { MockDriver } from '../../src/adapter/mock-driver.js';
import { AdminClient } from '../../src/admin/client.js';
import { createFileLogger } from '../../src/app/logger.js';
import { AgentRuntime, createAgentRuntime } from '../../src/app/runtime.js';
import { initializeConfig } from '../../src/config/initialize.js';

const PROMPT_SECRET = 'SECRET_PROMPT_7F3A';

const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

describe('agent logging', () => {
  it('never writes prompts, tokens or pairing codes to the log', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 's01-logging-'));
    const workspace = await mkdtemp(join(tmpdir(), 's01-logging-ws-'));
    const config = await initializeConfig({
      configDir,
      workspacePath: workspace,
      displayName: 'S01 Fixture',
      tailscaleBaseUrl: 'https://macbook.example-tailnet.ts.net',
    });
    const logFile = join(configDir, 'agent.log');
    const runtime = await createAgentRuntime(config, new MockDriver(), {
      configDir,
      phoneListen: { host: '127.0.0.1', port: 0 },
      logger: createFileLogger(logFile),
    });
    runtimes.push(runtime);
    await runtime.start();

    const admin = new AdminClient(join(configDir, 'agent.sock'));
    const pairing = await admin.pair();
    const address = runtime.address();
    if (address === null) throw new Error('not listening');
    const device = (await (
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

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: {
        authorization: `Bearer ${device.deviceId}.${device.deviceToken}`,
      },
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        messageId: 'msg_prompt',
        commandId: 'cmd_prompt',
        traceId: 'trace_prompt',
        timestamp: Date.now(),
        sourceDeviceId: device.deviceId,
        type: 'session.start',
        payload: { workspaceId: 'default', clientCapabilities: ['text'] },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const log = await readFile(logFile, 'utf8');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(PROMPT_SECRET);
    expect(log).not.toContain(device.deviceToken);
    expect(log).not.toContain(pairing.code);

    socket.terminate();
  });
});