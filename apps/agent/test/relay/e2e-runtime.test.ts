import { Buffer } from 'node:buffer';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocket } from 'ws';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ManagedRunDriver,
  ManagedRunHandle,
} from '../../src/adapter/managed-run-driver.js';
import { AdminClient } from '../../src/admin/client.js';
import { createDurableAgentRuntime } from '../../src/app/runtime.js';
import { resolveAgentPaths } from '../../src/config/paths.js';
import { relayLogin } from '../../src/relay/login.js';
import { login, RealRelay, startRealRelay } from './e2e-relay.js';

const PASSWORD = 'pw-123456';
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

class NoopDriver implements ManagedRunDriver {
  startRun(): ManagedRunHandle {
    return {
      interrupt: async () => undefined,
      close: async () => undefined,
      resumeEvents: () => undefined,
    };
  }
}

const NOW = 1_762_432_800_000;

function writeV3Config(configDir: string): void {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-rt-ws-')));
  writeFileSync(
    resolveAgentPaths(configDir).agentFile,
    `${JSON.stringify(
      {
        version: 3,
        desktopId: 'desktop_e2e',
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
}

async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('waitUntil timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let relay: RealRelay | null = null;
let runtime: Awaited<ReturnType<typeof createDurableAgentRuntime>> | null = null;
let configDir: string | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await runtime?.close();
  runtime = null;
  await relay?.stop();
  relay = null;
  if (configDir !== null) {
    rmSync(configDir, { recursive: true, force: true, maxRetries: 5 });
    configDir = null;
  }
});

function connectPhone(url: string, authorization: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { authorization } });
    socket.once('open', () => {
      sockets.push(socket);
      resolve(socket);
    });
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`upgrade rejected: ${response.statusCode}`));
    });
    socket.once('error', reject);
  });
}

function nextFrameWhere(
  socket: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('frame timeout'));
    }, timeoutMs);
    const onMessage = (data: import('ws').RawData): void => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(frame)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(frame);
    };
    socket.on('message', onMessage);
  });
}

describe('relay agent e2e（真实 relay + 真实 durable runtime）', () => {
  it('命令与三个 HTTP 端点经云端往返成功（Critical #1 回归）', async () => {
    relay = await startRealRelay();
    await relay.runAdmin(['admin', 'create-user', 'alice', '--password', PASSWORD]);

    configDir = mkdtempSync(join(tmpdir(), 'e2e-rt-'));
    writeV3Config(configDir);
    const bootstrap = await createDurableAgentRuntime(new NoopDriver(), {
      configDir,
      phoneListen: { host: '127.0.0.1', port: 0 },
    });
    await bootstrap.start();
    await bootstrap.close();

    const desktopLogin = await relayLogin({
      configDir,
      baseUrl: relay.baseUrl,
      username: 'alice',
      password: PASSWORD,
      desktopName: 'E2E Runtime Mac',
    });

    runtime = await createDurableAgentRuntime(new NoopDriver(), {
      configDir,
      phoneListen: { host: '127.0.0.1', port: 0 },
    });
    await runtime.start();
    const admin = new AdminClient(resolveAgentPaths(configDir).socketPath);
    await waitUntil(async () => {
      const status = (await admin.status()) as {
        relay?: { state?: string };
        desktopId?: string;
      };
      return status.relay?.state === 'ready';
    });

    const phone = (await login(relay.baseUrl, {
      username: 'alice',
      password: PASSWORD,
      clientType: 'phone',
      deviceName: 'E2E Phone',
      platform: 'ios',
      appVersion: '0.0.0',
    })) as { deviceId: string; deviceToken: string };
    const authorization = `Bearer ${phone.deviceId}.${phone.deviceToken}`;
    // 云端 desktopId 即桌面设备的 deviceId（relay login 返回），而非本地 desktopId。
    const desktopId = desktopLogin.deviceId;
    const wsBase = relay.baseUrl.replace(/^http/, 'ws');

    const control = await connectPhone(
      `${wsBase}/ws?desktopId=${encodeURIComponent(desktopId)}`,
      authorization,
    );
    const readyFrame = nextFrameWhere(control, (frame) => frame['type'] === 'connection.ready');
    control.send(
      JSON.stringify({
        protocolVersion: 1,
        messageId: 'msg_hello',
        timestamp: Date.now(),
        type: 'connection.hello',
        payload: {
          supportedProtocolVersions: [1],
          appVersion: '0.0.0',
          deviceId: phone.deviceId,
          capabilities: [],
          handshakeId: 'hs_e2e_runtime',
        },
      }),
    );
    await readyFrame;

    // 命令 round-trip：workspace.list 必须有 command.result 回应。
    const frames: Array<Record<string, unknown>> = [];
    const collector = (data: import('ws').RawData): void => {
      try {
        frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch {
        // 非 JSON 帧忽略
      }
    };
    control.on('message', collector);
    control.send(
      JSON.stringify({
        protocolVersion: 1,
        messageId: 'msg_cmd_1',
        commandId: 'cmd_e2e_1',
        traceId: 'trace_e2e_1',
        timestamp: Date.now(),
        type: 'workspace.list',
        payload: {},
      }),
    );
    await waitUntil(() =>
      frames.some((frame) => frame['type'] === 'command.result'),
    );
    control.off('message', collector);
    const result = frames.find((frame) => frame['type'] === 'command.result');
    expect(result, `frames=${JSON.stringify(frames)}`).toBeDefined();
    expect(result?.['commandId']).toBe('cmd_e2e_1');
    expect(result?.['payload']).toMatchObject({ status: 'ok' });

    // 三个 HTTP 端点经云端往返。
    const proxy = (path: string): string =>
      `${relay?.baseUrl}${path}?desktopId=${encodeURIComponent(desktopId)}`;

    const upload = await fetch(proxy('/v1/attachments'), {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        mediaType: 'image/png',
        dataBase64: PNG_BYTES.toString('base64'),
      }),
    });
    expect(upload.status).toBe(201);
    expect(
      ((await upload.json()) as { attachmentId: string }).attachmentId,
    ).toMatch(/^att_/);

    // chunkIndex 同时验证查询参数跨 relay 透传。
    const approvals = await fetch(
      `${proxy('/v1/approvals/ap_missing/content')}&chunkIndex=0`,
      { headers: { authorization } },
    );
    expect(approvals.status).toBe(404);
    expect(
      ((await approvals.json()) as { error: { code: string } }).error.code,
    ).toBe('APPROVAL_NOT_FOUND');

    const prompt = await fetch(proxy('/v1/runs/run_missing/prompt'), {
      headers: { authorization },
    });
    expect(prompt.status).toBe(404);
    expect(
      ((await prompt.json()) as { error: { code: string } }).error.code,
    ).toBe('RUN_NOT_FOUND');
  }, 40000);
});