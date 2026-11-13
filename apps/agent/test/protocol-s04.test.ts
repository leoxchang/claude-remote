import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateProtocolMessage } from '@claude-remote/protocol/validator';
import { CommandMessage } from '@claude-remote/protocol/types';

function example(name: string): Record<string, unknown> {
  const path = fileURLToPath(
    new URL(`../../../protocol/v1/examples/s04/${name}`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const VALID = [
  'run-requeue.json',
  'run-recovery-required.json',
  'session-sync-page.json',
  'session-sync-resync.json',
  'snapshot-page-0.json',
  'snapshot-page-1.json',
  'command-result-expired.json',
  'recovery-generation-conflict.json',
] as const;

describe('S04 shared protocol examples', () => {
  it('accepts every shared example and exposes the S04 types', () => {
    for (const name of VALID) {
      const message = example(name);
      const result = validateProtocolMessage(message);
      expect(result.valid, name).toBe(true);
      if (!result.valid) continue;
      expect(result.message.type, name).toBe(message['type']);
    }
  });

  it('keeps session.sync pages tied to original event identity', () => {
    const page = example('session-sync-page.json');
    const data = (page['payload'] as { data: { events: unknown[] } }).data;
    const events = data.events as Array<Record<string, unknown>>;
    expect(events.map((event) => event['eventId'])).toEqual([
      'event_1',
      'event_2',
    ]);
    expect(events.map((event) => event['seq'])).toEqual([1, 2]);
    expect(JSON.stringify(page)).not.toContain('"text"');
    expect(JSON.stringify(page)).not.toContain('prompt');
  });

  it('returns only a snapshot manifest with RESYNC_REQUIRED', () => {
    const resync = example('session-sync-resync.json');
    const payload = resync['payload'] as {
      status: string;
      error: { code: string; details: Record<string, unknown> };
    };
    expect(payload.status).toBe('error');
    expect(payload.error.code).toBe('RESYNC_REQUIRED');
    expect(Object.keys(payload.error.details)).toEqual(['snapshot']);
    expect(JSON.stringify(resync)).not.toContain('recentEvents');
  });

  it('shares one immutable manifest across snapshot pages', () => {
    const first = example('snapshot-page-0.json');
    const second = example('snapshot-page-1.json');
    const firstPayload = first['payload'] as Record<string, unknown>;
    const secondPayload = second['payload'] as Record<string, unknown>;
    for (const key of ['snapshotId', 'lastSeq', 'pageCount', 'sha256']) {
      expect(firstPayload[key]).toBe(secondPayload[key]);
    }
    expect(firstPayload['pageIndex']).toBe(0);
    expect(secondPayload['pageIndex']).toBe(1);
    expect(firstPayload['recoveryRequiredRuns']).toEqual([]);
  });

  it('rejects invalid afterSeq, limit, pageIndex and generation', () => {
    const sync = example('session-sync-page.json');
    const invalidSync = (payload: Record<string, unknown>): unknown => ({
      ...sync,
      type: 'session.sync',
      payload,
      commandId: 'cmd_sync_invalid',
      traceId: 'trace_sync_invalid',
      sessionId: 'session_01',
    });
    expect(validateProtocolMessage(invalidSync({ afterSeq: -1 })).valid).toBe(
      false,
    );
    expect(
      validateProtocolMessage(invalidSync({ afterSeq: 0, limit: 101 })).valid,
    ).toBe(false);

    const requeue = example('run-requeue.json');
    const invalidRequeue = {
      ...requeue,
      payload: { expectedRecoveryGeneration: -1 },
    };
    expect(validateProtocolMessage(invalidRequeue).valid).toBe(false);

    const snapshot = example('snapshot-page-0.json');
    expect(
      validateProtocolMessage({
        ...snapshot,
        type: 'session.snapshot',
        commandId: 'cmd_snapshot_page',
        traceId: 'trace_snapshot_page',
        sessionId: 'session_01',
        payload: { snapshotId: 'snap_01', pageIndex: 8 },
      }).valid,
    ).toBe(false);
  });

  it('does not treat unknown recovery or sync types as no-ops', () => {
    const base = example('run-requeue.json');
    const unknown = {
      ...base,
      type: 'run.restore',
      messageId: 'msg_unknown',
    };
    const result = validateProtocolMessage(unknown);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.map((error) => error.code)).toContain(
      'UNKNOWN_MESSAGE_TYPE',
    );
    expect((unknown as CommandMessage).payload).toEqual({
      expectedRecoveryGeneration: 1,
    });
  });

  it('ships exactly the documented example set', () => {
    const files = readdirSync(
      fileURLToPath(new URL('../../../protocol/v1/examples/s04/', import.meta.url)),
    );
    expect(files.sort()).toEqual([...VALID].sort());
  });
});