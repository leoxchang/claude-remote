import { describe, expect, it } from 'vitest';

import { negotiateProtocolVersion } from '../src/handshake.js';
import { validateProtocolMessage } from '../src/validator.js';
import { recordEvidenceIfEnabled } from '../../../scripts/s00/evidence.js';

const hello = {
  protocolVersion: 1,
  messageId: 'msg_hello_01',
  timestamp: 1762432800200,
  type: 'connection.hello',
  payload: {
    supportedProtocolVersions: [1],
    appVersion: '0.0.1',
    deviceId: 'device_phone_01',
    capabilities: ['text'],
    handshakeId: 'handshake_01',
  },
};

const ready = {
  protocolVersion: 1,
  messageId: 'msg_ready_01',
  timestamp: 1762432800201,
  type: 'connection.ready',
  payload: {
    protocolVersion: 1,
    desktopId: 'desktop_mac_01',
    agentVersion: '0.0.1',
    sdkVersion: '0.3.319',
    runtimeVersion: '2.1.319',
    capabilities: ['text', 'message.delta'],
    handshakeId: 'handshake_01',
  },
};

describe('connection handshake', () => {
  it('accepts hello and ready control messages without a session seq', () => {
    expect(validateProtocolMessage(hello).valid).toBe(true);
    expect(validateProtocolMessage(ready).valid).toBe(true);
    expect(hello).not.toHaveProperty('seq');
    expect(ready).not.toHaveProperty('seq');
    expect(ready.payload.handshakeId).toBe(hello.payload.handshakeId);
  });

  it('selects protocol version 1 when the client supports it', () => {
    const result = negotiateProtocolVersion(hello.payload);

    expect(result).toEqual({ accepted: true, protocolVersion: 1 });
  });

  it('rejects a client that does not support version 1', () => {
    const result = negotiateProtocolVersion({
      ...hello.payload,
      supportedProtocolVersions: [2],
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.error.code).toBe('VERSION_INCOMPATIBLE');
  });

  it('records PROTO-11 evidence', async () => {
    const rejected = negotiateProtocolVersion({
      ...hello.payload,
      supportedProtocolVersions: [2],
    });
    await recordEvidenceIfEnabled({
      id: 'PROTO-11',
      status:
        validateProtocolMessage(hello).valid &&
        validateProtocolMessage(ready).valid &&
        rejected.accepted === false
          ? 'PASS'
          : 'FAIL',
      summary:
        'hello/ready agree on protocol version 1, and an incompatible client gets VERSION_INCOMPATIBLE',
      observedAt: new Date().toISOString(),
      data: {
        supportedProtocolVersions: [1],
        incompatibleCode: rejected.accepted ? null : rejected.error.code,
        handshakeCarriesSeq: false,
      },
    });
  });
});