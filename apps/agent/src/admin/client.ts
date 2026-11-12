import { request } from 'node:http';

import { DeviceRecord } from '../domain/types.js';
import { PairingQrPayload } from '../pairing/pairing-service.js';
import { WorkspaceSummary } from '../workspace/workspace-types.js';
import { AdminStatus } from './server.js';

/** 管理接口返回的结构化错误。 */
export class AdminError extends Error {
  constructor(readonly code: string, message: string = code) {
    super(message);
    this.name = 'AdminError';
  }
}

/** 通过 Unix socket 调用运行中 Agent 的本机管理接口。 */
export class AdminClient {
  constructor(private readonly socketPath: string) {}

  status(): Promise<AdminStatus> {
    return this.request<AdminStatus>('GET', '/admin/v1/status');
  }

  devices(): Promise<DeviceRecord[]> {
    return this.request<DeviceRecord[]>('GET', '/admin/v1/devices');
  }

  pair(replace: boolean = false): Promise<PairingQrPayload> {
    return this.request<PairingQrPayload>('POST', '/admin/v1/pair', { replace });
  }

  revoke(deviceId: string): Promise<DeviceRecord> {
    return this.request<DeviceRecord>('POST', '/admin/v1/revoke', {
      deviceId,
    });
  }

  workspaceList(): Promise<WorkspaceSummary[]> {
    return this.request<WorkspaceSummary[]>('GET', '/admin/v1/workspaces');
  }

  workspaceAdd(path: string, displayName: string): Promise<WorkspaceSummary> {
    return this.request<WorkspaceSummary>('POST', '/admin/v1/workspaces/add', {
      path,
      displayName,
    });
  }

  workspaceRename(
    workspaceId: string,
    displayName: string,
  ): Promise<WorkspaceSummary> {
    return this.request<WorkspaceSummary>(
      'POST',
      '/admin/v1/workspaces/rename',
      { workspaceId, displayName },
    );
  }

  workspaceRemove(
    workspaceId: string,
  ): Promise<{ workspaceId: string; removed: boolean }> {
    return this.request<{ workspaceId: string; removed: boolean }>(
      'POST',
      '/admin/v1/workspaces/remove',
      { workspaceId },
    );
  }

  private request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers:
            payload === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((response.statusCode ?? 0) >= 400) {
              reject(toAdminError(text));
              return;
            }
            const parsed = parseJson(text);
            if (parsed === undefined) {
              reject(
                new AdminError('INVALID_RESPONSE', 'admin response was not JSON'),
              );
              return;
            }
            resolve(parsed as T);
          });
        },
      );
      req.on('error', (error) => reject(error));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toAdminError(text: string): AdminError {
  const parsed = parseJson(text) as
    | { error?: { code?: unknown; message?: unknown } }
    | undefined;
  const code = parsed?.error?.code;
  const message = parsed?.error?.message;
  if (typeof code === 'string') {
    return new AdminError(code, typeof message === 'string' ? message : code);
  }
  return new AdminError('INTERNAL_ERROR', 'admin request failed');
}