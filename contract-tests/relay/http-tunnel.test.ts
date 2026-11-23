import { randomBytes } from 'node:crypto';

import { WebSocket } from 'ws';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bearer,
  Credential,
  createAccount,
  DesktopClient,
  desktopLogin,
  login,
  openDesktop,
  phoneLogin,
} from './helpers/clients.js';
import { RelayHandle, startRelay } from './helpers/harness.js';

const PASSWORD = 'pw-123456';

let handle: RelayHandle | null = null;

afterEach(async () => {
  await handle?.stop();
  handle = null;
});

interface Setup {
  relay: RelayHandle;
  desktop: DesktopClient;
  phone: Credential;
  desktopId: string;
}

async function bootstrap(): Promise<{
  relay: RelayHandle;
  desktopCredential: Credential;
  phone: Credential;
}> {
  handle = await startRelay();
  await createAccount(handle, 'alice', PASSWORD);
  const desktopCredential = await login(
    handle.baseUrl,
    desktopLogin('alice', PASSWORD),
  );
  const phone = await login(handle.baseUrl, phoneLogin('alice', PASSWORD));
  return { relay: handle, desktopCredential, phone };
}

async function setup(): Promise<Setup> {
  const base = await bootstrap();
  const desktop = await openDesktop(base.relay.baseUrl, base.desktopCredential);
  return {
    relay: base.relay,
    desktop,
    phone: base.phone,
    desktopId: base.desktopCredential.deviceId,
  };
}

function proxyUrl(relay: RelayHandle, path: string, desktopId: string): string {
  return `${relay.baseUrl}${path}?desktopId=${encodeURIComponent(desktopId)}`;
}

function authHeaders(phone: Credential): Record<string, string> {
  return { authorization: bearer(phone) };
}

async function errorCodeOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

describe('契约 §5.4 HTTP 代答', () => {
  it('POST attachments 代答，请求体/响应体逐字节一致', async () => {
    const { relay, desktop, phone, desktopId } = await setup();
    const body = randomBytes(1024 * 1024);
    const pending = fetch(proxyUrl(relay, '/v1/attachments', desktopId), {
      method: 'POST',
      headers: {
        ...authHeaders(phone),
        'content-type': 'application/json',
      },
      body,
    });

    const request = await desktop.nextMessage();
    const payload = request['payload'] as Record<string, string>;
    expect(request['type']).toBe('http.request');
    expect(payload['method']).toBe('POST');
    expect(payload['path']).toBe('/v1/attachments');
    expect(payload['deviceId']).toBe(phone.deviceId);
    expect(payload['contentType']).toBe('application/json');
    expect(Buffer.from(payload['bodyBase64'] ?? '', 'base64').equals(body)).toBe(
      true,
    );

    const responseBody = Buffer.from('{"attachmentId":"att_1"}');
    desktop.send({
      type: 'http.response',
      payload: {
        requestId: payload['requestId'],
        status: 200,
        contentType: 'application/json',
        bodyBase64: responseBody.toString('base64'),
      },
    });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(responseBody.toString('utf8'));
  });

  it('GET 审批内容路径参数与查询参数原样转发，无 bodyBase64', async () => {
    const { relay, desktop, phone, desktopId } = await setup();
    const pending = fetch(
      proxyUrl(relay, '/v1/approvals/ap_1/content', desktopId) +
        '&chunkIndex=2',
      { headers: authHeaders(phone) },
    );
    const request = await desktop.nextMessage();
    const payload = request['payload'] as Record<string, string>;
    expect(payload['method']).toBe('GET');
    expect(payload['path']).toBe('/v1/approvals/ap_1/content');
    expect(payload['query']).toEqual({ chunkIndex: '2' });
    expect(payload['bodyBase64']).toBeUndefined();

    desktop.send({
      type: 'http.response',
      payload: {
        requestId: payload['requestId'],
        status: 404,
        contentType: 'application/json',
        bodyBase64: Buffer.from('{"error":{"code":"APPROVAL_NOT_FOUND"}}').toString(
          'base64',
        ),
      },
    });
    const response = await pending;
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('APPROVAL_NOT_FOUND');
  });

  it('白名单外路径 404 ROUTE_NOT_FOUND 且不产生 http.request', async () => {
    const { relay, desktop, phone, desktopId } = await setup();
    const response = await fetch(
      proxyUrl(relay, '/v1/pairings', desktopId),
      { headers: authHeaders(phone) },
    );
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('ROUTE_NOT_FOUND');
    await expect(desktop.nextMessage(300)).rejects.toThrow('message timeout');
  });

  it('桌面离线 503 DESKTOP_OFFLINE；跨账号 404（Review Focus 2）', async () => {
    const { relay, desktopCredential, phone } = await bootstrap();
    const offline = await fetch(
      proxyUrl(relay, '/v1/runs/run_1/prompt', desktopCredential.deviceId),
      { headers: authHeaders(phone) },
    );
    expect(offline.status).toBe(503);
    expect(await errorCodeOf(offline)).toBe('DESKTOP_OFFLINE');

    await openDesktop(relay.baseUrl, desktopCredential);
    await createAccount(relay, 'bob', PASSWORD);
    const bobPhone = await login(relay.baseUrl, phoneLogin('bob', PASSWORD));
    const crossAccount = await fetch(
      proxyUrl(relay, '/v1/runs/run_1/prompt', desktopCredential.deviceId),
      { headers: authHeaders(bobPhone) },
    );
    expect(crossAccount.status).toBe(404);
    expect(await errorCodeOf(crossAccount)).toBe('DESKTOP_NOT_FOUND');
  });

  it('迟到的未知 requestId 响应被丢弃，连接存活且后续代答正常（Review Focus 5）', async () => {
    const { relay, desktop, phone, desktopId } = await setup();
    desktop.send({
      type: 'http.response',
      payload: { requestId: 'req_late', status: 200, bodyBase64: '' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(desktop.socket.readyState).toBe(WebSocket.OPEN);

    const pending = fetch(proxyUrl(relay, '/v1/runs/run_2/prompt', desktopId), {
      headers: authHeaders(phone),
    });
    const request = await desktop.nextMessage();
    const payload = request['payload'] as Record<string, string>;
    desktop.send({
      type: 'http.response',
      payload: {
        requestId: payload['requestId'],
        status: 200,
        contentType: 'text/plain',
        bodyBase64: Buffer.from('works').toString('base64'),
      },
    });
    const response = await pending;
    expect(await response.text()).toBe('works');
  });

  it('缺 desktopId 400 INVALID_REQUEST；未鉴权 401', async () => {
    const { relay, phone } = await setup();
    const missing = await fetch(`${relay.baseUrl}/v1/attachments`, {
      method: 'POST',
      headers: { ...authHeaders(phone), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(400);

    const unauthenticated = await fetch(
      `${relay.baseUrl}/v1/attachments?desktopId=dev_x`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(unauthenticated.status).toBe(401);
  });

  it('重复 http.response 只生效一次，连接存活', async () => {
    const { relay, desktop, phone, desktopId } = await setup();
    const pending = fetch(proxyUrl(relay, '/v1/runs/run_dup/prompt', desktopId), {
      headers: authHeaders(phone),
    });
    const request = await desktop.nextMessage();
    const payload = request['payload'] as Record<string, string>;
    const response = {
      type: 'http.response',
      payload: {
        requestId: payload['requestId'],
        status: 200,
        bodyBase64: Buffer.from('once').toString('base64'),
      },
    };
    desktop.send(response);
    desktop.send(response);
    expect(await (await pending).text()).toBe('once');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(desktop.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('请求体超过 12 MiB → 413 BODY_TOO_LARGE（契约 §2.1）', async () => {
    const { relay, phone, desktopId } = await setup();
    const response = await fetch(proxyUrl(relay, '/v1/attachments', desktopId), {
      method: 'POST',
      headers: { ...authHeaders(phone), 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(13 * 1024 * 1024, 1),
    });
    expect(response.status).toBe(413);
    expect(await errorCodeOf(response)).toBe('BODY_TOO_LARGE');
  }, 30000);

  it('恰好 12 MiB 代答体通过（C2 边界）', async () => {
    const { relay, desktop, phone, desktopId } = await setup();
    const body = Buffer.alloc(12 * 1024 * 1024, 9);
    const pending = fetch(proxyUrl(relay, '/v1/runs/run_big/prompt', desktopId), {
      headers: authHeaders(phone),
    });
    const request = await desktop.nextMessage();
    desktop.send({
      type: 'http.response',
      payload: {
        requestId: (request['payload'] as Record<string, string>)['requestId'],
        status: 200,
        contentType: 'application/octet-stream',
        bodyBase64: body.toString('base64'),
      },
    });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).length).toBe(body.length);
    expect(desktop.socket.readyState).toBe(WebSocket.OPEN);
  }, 30000);
});