import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RESERVED_MESSAGE_TYPES } from '@claude-remote/protocol/types';
import { validateProtocolMessage } from '@claude-remote/protocol/validator';
import { describe, expect, it } from 'vitest';

const EXAMPLES_DIR = fileURLToPath(
  new URL('../../../protocol/v1/examples/s02/', import.meta.url),
);

function readExample(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(`${EXAMPLES_DIR}${name}`, 'utf8'),
  ) as Record<string, unknown>;
}

const LEGAL_EXAMPLES = [
  'workspace-list.json',
  'session-list-page.json',
  'run-queued.json',
  'run-started.json',
  'queue-remove.json',
  'session-snapshot.json',
  'command-id-conflict.json',
  'invalid-cursor.json',
];

describe('S02 protocol examples', () => {
  it('ships exactly the documented example files', () => {
    expect(readdirSync(EXAMPLES_DIR).sort()).toEqual([...LEGAL_EXAMPLES].sort());
  });

  it.each(LEGAL_EXAMPLES)('accepts %s', (name) => {
    const result = validateProtocolMessage(readExample(name));

    expect(result.valid).toBe(true);
  });

  it('carries the documented error codes in the error examples', () => {
    const conflict = readExample('command-id-conflict.json');
    const cursor = readExample('invalid-cursor.json');

    expect(
      (conflict['payload'] as { error: { code: string } }).error.code,
    ).toBe('COMMAND_ID_CONFLICT');
    expect((cursor['payload'] as { error: { code: string } }).error.code).toBe(
      'INVALID_CURSOR',
    );
  });

  it('no longer reserves the S02 message types', () => {
    const commands: Array<{ type: string; payload: Record<string, unknown> }> = [
      { type: 'workspace.list', payload: {} },
      { type: 'session.create', payload: { workspaceId: 'ws_alpha' } },
      { type: 'session.list', payload: { workspaceId: 'ws_alpha' } },
      { type: 'session.resume', payload: { sessionId: 'session_alpha' } },
      {
        type: 'session.rename',
        payload: { sessionId: 'session_alpha', title: 'Renamed' },
      },
      { type: 'session.archive', payload: { sessionId: 'session_alpha' } },
      { type: 'queue.remove', payload: {} },
    ];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [
      { type: 'run.queued', payload: { enqueuedAt: 1_762_432_800_000 } },
      {
        type: 'run.started',
        payload: { startedAt: 1_762_432_800_000, status: 'starting' },
      },
    ];
    const s02Types = [...commands, ...events].map((entry) => entry.type);

    expect(RESERVED_MESSAGE_TYPES.filter((type) => s02Types.includes(type))).toEqual(
      [],
    );
    for (const command of commands) {
      const result = validateProtocolMessage({
        protocolVersion: 1,
        messageId: `msg_${command.type}`,
        timestamp: 1_762_432_800_000,
        type: command.type,
        commandId: `cmd_${command.type}`,
        traceId: `trace_${command.type}`,
        sessionId: 'session_alpha',
        workspaceId: 'ws_alpha',
        runId: 'run_alpha',
        payload: command.payload,
      });
      expect(result.valid, `${command.type} should be a known type`).toBe(true);
    }
    for (const event of events) {
      const result = validateProtocolMessage({
        protocolVersion: 1,
        messageId: `msg_${event.type}`,
        timestamp: 1_762_432_800_000,
        type: event.type,
        eventId: `event_${event.type}`,
        sessionId: 'session_alpha',
        seq: 1,
        runId: 'run_alpha',
        payload: event.payload,
      });
      expect(result.valid, `${event.type} should be a known type`).toBe(true);
    }
  });
});