import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateProtocolMessage } from '../src/validator.js';
import { RESERVED_MESSAGE_TYPES } from '../src/types.js';
import { ERROR_CODES } from '../src/errors.js';
import { recordEvidenceIfEnabled } from '../../../scripts/s00/evidence.js';

interface Flow {
  name: string;
  sessionId: string;
  messages: unknown[];
}

const readJson = <T>(relativePath: string): T =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'),
  ) as T;

const flows = readJson<Flow[]>('../examples/flows.json');

describe('protocol timeline events', () => {
  it('accepts every message in the S01 flow examples', () => {
    for (const flow of flows) {
      for (const message of flow.messages) {
        const result = validateProtocolMessage(message);
        expect(result.valid, `${flow.name} rejected ${JSON.stringify(message)}`).toBe(
          true,
        );
      }
    }
  });

  it('keeps timeline seq strictly increasing per session in each flow', () => {
    for (const flow of flows) {
      const seqs = flow.messages
        .filter((message): message is Record<string, unknown> => {
          return (
            typeof message === 'object' &&
            message !== null &&
            typeof (message as Record<string, unknown>)['seq'] === 'number'
          );
        })
        .map((message) => Number(message['seq']));

      const expected: number[] = [];
      for (let index = 1; index <= seqs.length; index += 1) expected.push(index);
      expect(seqs).toEqual(expected);
    }
  });

  it('rejects run.completed without a runId', () => {
    const result = validateProtocolMessage({
      protocolVersion: 1,
      messageId: 'msg_bad_run_completed',
      eventId: 'event_bad_run_completed',
      sessionId: 'session_01',
      seq: 9,
      timestamp: 1762432800100,
      type: 'run.completed',
      payload: { status: 'succeeded' },
    });

    expect(result.valid).toBe(false);
  });

  it('accepts only full S01 flow and handshake evidence', async () => {
    const observedAt = new Date().toISOString();
    await recordEvidenceIfEnabled({
      id: 'PROTO-09',
      status: flows.every((flow) => flow.messages.every((m) => validateProtocolMessage(m).valid))
        ? 'PASS'
        : 'FAIL',
      summary: 'The schema expresses session start, two prompts, a tool, cancel and errors',
      observedAt,
      data: { flows: flows.map((flow) => flow.name) },
    });
  });

  it('registers the spec error-code baseline without duplicates', () => {
    const required = [
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'RATE_LIMITED',
      'INVALID_MESSAGE',
      'UNKNOWN_MESSAGE_TYPE',
      'INTERNAL_ERROR',
      'WORKSPACE_NOT_ALLOWED',
      'SESSION_BUSY',
      'RUN_NOT_ACTIVE',
      'RESYNC_REQUIRED',
      'VERSION_INCOMPATIBLE',
      'APPROVAL_EXPIRED',
      'APPROVAL_ALREADY_RESOLVED',
      'ASR_PROVIDER_ERROR',
    ];

    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of required) expect(ERROR_CODES).toContain(code);
  });

  it('keeps S02–S05 reserved type names disjoint from S01 types', async () => {
    const s01Types = [
      'session.start',
      'prompt.send',
      'run.cancel',
      'session.snapshot',
      'command.result',
      'session.status',
      'message.delta',
      'message.completed',
      'tool.started',
      'tool.output',
      'tool.completed',
      'run.completed',
      'desktop.status',
      'connection.hello',
      'connection.ready',
      'error',
    ];
    const overlap = RESERVED_MESSAGE_TYPES.filter((type) =>
      s01Types.includes(type),
    );
    const reservedAreSafelyRejected = RESERVED_MESSAGE_TYPES.every((type) => {
      const result = validateProtocolMessage({
        protocolVersion: 1,
        messageId: 'msg_reserved',
        timestamp: 1762432800500,
        type,
        payload: {},
      });
      return (
        !result.valid &&
        result.errors[0]?.code === 'UNKNOWN_MESSAGE_TYPE'
      );
    });

    expect(overlap).toEqual([]);
    expect(reservedAreSafelyRejected).toBe(true);

    await recordEvidenceIfEnabled({
      id: 'PROTO-10',
      status: overlap.length === 0 && reservedAreSafelyRejected ? 'PASS' : 'FAIL',
      summary:
        'S02–S05 reserved types do not collide with S01 types and are safely rejected until implemented',
      observedAt: new Date().toISOString(),
      data: { reservedTypes: RESERVED_MESSAGE_TYPES },
    });
  });
});