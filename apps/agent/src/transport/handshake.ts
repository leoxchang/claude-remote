import { ConnectionHelloPayload } from '@claude-remote/protocol/handshake';
import { ControlMessage } from '@claude-remote/protocol/types';

import { randomBase64Url } from '../security/random.js';

const MESSAGE_ID_BYTES = 9;

/** 握手阶段的失败码。 */
export type HandshakeErrorCode = 'INVALID_MESSAGE';

/** 握手消息不合法。 */
export class HandshakeError extends Error {
  constructor(
    readonly code: HandshakeErrorCode = 'INVALID_MESSAGE',
    message: string = code,
  ) {
    super(message);
    this.name = 'HandshakeError';
  }
}

/** 解析并校验首条 connection.hello；其他类型一律拒绝。 */
export function parseHelloMessage(raw: string): ConnectionHelloPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HandshakeError('INVALID_MESSAGE', 'handshake must be JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new HandshakeError('INVALID_MESSAGE', 'handshake must be an object');
  }
  const message = parsed as Record<string, unknown>;
  if (message['type'] !== 'connection.hello') {
    throw new HandshakeError(
      'INVALID_MESSAGE',
      'first message must be connection.hello',
    );
  }
  const payload = message['payload'];
  if (typeof payload !== 'object' || payload === null) {
    throw new HandshakeError('INVALID_MESSAGE', 'hello payload is required');
  }
  const hello = payload as Record<string, unknown>;
  if (
    !Array.isArray(hello['supportedProtocolVersions']) ||
    !hello['supportedProtocolVersions'].every(
      (version) => typeof version === 'number',
    )
  ) {
    throw new HandshakeError('INVALID_MESSAGE', 'invalid protocol versions');
  }
  return {
    supportedProtocolVersions: hello['supportedProtocolVersions'] as number[],
    appVersion: requireString(hello, 'appVersion'),
    deviceId: requireString(hello, 'deviceId'),
    capabilities: requireStringArray(hello, 'capabilities'),
    handshakeId: requireString(hello, 'handshakeId'),
  };
}

/** 构造 connection.ready；原样回显 handshakeId。 */
export function createReadyMessage(input: {
  desktopId: string;
  connectionEpoch: number;
  versions: { agent: string; sdk: string; runtime: string };
  capabilities: string[];
  handshakeId: string;
  agentInstanceId?: string;
}): ControlMessage {
  return {
    protocolVersion: 1,
    messageId: `msg_${randomBase64Url(MESSAGE_ID_BYTES)}`,
    timestamp: Date.now(),
    type: 'connection.ready',
    payload: {
      desktopId: input.desktopId,
      connectionEpoch: input.connectionEpoch,
      versions: input.versions,
      capabilities: input.capabilities,
      handshakeId: input.handshakeId,
      ...(input.agentInstanceId === undefined
        ? {}
        : { agentInstanceId: input.agentInstanceId }),
    },
  };
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HandshakeError('INVALID_MESSAGE', `hello ${key} is required`);
  }
  return value;
}

function requireStringArray(
  source: Record<string, unknown>,
  key: string,
): string[] {
  const value = source[key];
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === 'string')
  ) {
    throw new HandshakeError('INVALID_MESSAGE', `hello ${key} is required`);
  }
  return value as string[];
}