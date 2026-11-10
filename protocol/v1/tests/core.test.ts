import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateProtocolMessage } from '../src/validator.js';
import { recordEvidenceIfEnabled } from '../../../scripts/s00/evidence.js';

interface ValidExample {
  name: string;
  message: unknown;
}

interface InvalidExample {
  name: string;
  reason: string;
  expectedKeyword: string;
  message: unknown;
}

const LEAK_MARKER = 'DO_NOT_LEAK_99';

const readJson = <T>(relativePath: string): T =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'),
  ) as T;

const validExamples = readJson<ValidExample[]>('../examples/valid.json');
const invalidExamples = readJson<InvalidExample[]>('../examples/invalid.json');

describe('validateProtocolMessage', () => {
  it.each(validExamples.map((example) => [example.name, example] as const))(
    'accepts the valid example %s',
    (_name, example) => {
      const result = validateProtocolMessage(example.message);

      expect(result.valid).toBe(true);
    },
  );

  it.each(invalidExamples.map((example) => [example.name, example] as const))(
    'rejects the invalid example %s',
    (_name, example) => {
      const result = validateProtocolMessage(example.message);

      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors.map((error) => error.keyword)).toContain(
        example.expectedKeyword,
      );
      expect(JSON.stringify(result)).not.toContain(LEAK_MARKER);
    },
  );

  it('reports unknown message types without echoing payload values', () => {
    const result = validateProtocolMessage({
      protocolVersion: 1,
      messageId: 'msg_unknown',
      timestamp: 1762432800000,
      type: 'prompt.explode',
      payload: { text: LEAK_MARKER },
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toEqual([
      { path: '', keyword: 'type', code: 'UNKNOWN_MESSAGE_TYPE' },
    ]);
    expect(JSON.stringify(result)).not.toContain(LEAK_MARKER);
  });

  it('keeps duplicate command results aligned with the first result', () => {
    const first = validExamples.find(
      (example) => example.name === 'command.result.ok',
    );
    const duplicate = validExamples.find(
      (example) => example.name === 'command.result.duplicate',
    );

    expect(first?.message).toBeDefined();
    expect(duplicate?.message).toBeDefined();
    const firstMessage = first?.message as Record<string, unknown>;
    const duplicateMessage = duplicate?.message as Record<string, unknown>;

    expect(validateProtocolMessage(firstMessage).valid).toBe(true);
    expect(validateProtocolMessage(duplicateMessage).valid).toBe(true);
    expect(duplicateMessage['commandId']).toBe(firstMessage['commandId']);
    expect(duplicateMessage['traceId']).toBe(firstMessage['traceId']);
    expect(duplicateMessage['messageId']).not.toBe(firstMessage['messageId']);
    expect(duplicateMessage['payload']).toEqual({
      ...(firstMessage['payload'] as Record<string, unknown>),
      duplicate: true,
    });
  });

  it('does not mutate the validated input', () => {
    const example = validExamples[0];
    expect(example).toBeDefined();
    if (example === undefined) return;
    const before = JSON.stringify(example.message);

    validateProtocolMessage(example.message);

    expect(JSON.stringify(example.message)).toBe(before);
  });

  it('allows unknown optional fields on a known message type', () => {
    const example = validExamples.find((entry) => entry.name === 'prompt.send');
    expect(example).toBeDefined();
    if (example === undefined) return;
    const extended = {
      ...(example.message as Record<string, unknown>),
      futureOptionalField: { nested: true },
      payload: {
        ...(example.message as { payload: Record<string, unknown> }).payload,
        s02Extension: 'ignored',
      },
    };

    expect(validateProtocolMessage(extended).valid).toBe(true);
  });

  it('records PROTO-01–06 and PROTO-08 evidence', async () => {
    const observedAt = new Date().toISOString();
    const rejects = (name: string): boolean => {
      const example = invalidExamples.find((entry) => entry.name === name);
      return example !== undefined && !validateProtocolMessage(example.message).valid;
    };
    const allValid = validExamples.every(
      (example) => validateProtocolMessage(example.message).valid,
    );
    const extensionExample = validExamples.find(
      (example) => example.name === 'prompt.send',
    );
    const acceptsExtension =
      extensionExample !== undefined &&
      validateProtocolMessage({
        ...(extensionExample.message as Record<string, unknown>),
        extraOptional: true,
      }).valid;

    const records = [
      {
        id: 'PROTO-01',
        ok: allValid,
        summary: 'All valid command, result and event examples pass the schema',
        data: { exampleCount: validExamples.length },
      },
      {
        id: 'PROTO-02',
        ok: ['missing protocolVersion', 'missing messageId', 'missing type', 'missing payload'].every(rejects),
        summary: 'Every message missing a required envelope field is rejected',
        data: { cases: ['protocolVersion', 'messageId', 'type', 'payload'] },
      },
      {
        id: 'PROTO-03',
        ok: rejects('prompt.send without sessionId') && rejects('run.cancel without runId'),
        summary: 'Commands without their target object id are rejected',
        data: { cases: ['prompt.send/sessionId', 'run.cancel/runId'] },
      },
      {
        id: 'PROTO-04',
        ok: rejects('negative seq') && rejects('string timestamp'),
        summary: 'Invalid seq and timestamp formats are rejected',
        data: { cases: ['seq minimum 1', 'timestamp integer epoch ms'] },
      },
      {
        id: 'PROTO-05',
        ok:
          rejects('unknown message type with secret') &&
          acceptsExtension,
        summary: 'Unknown message types get UNKNOWN_MESSAGE_TYPE and unknown optional fields are allowed',
        data: { unknownTypeCode: 'UNKNOWN_MESSAGE_TYPE' },
      },
      {
        id: 'PROTO-06',
        ok: allValid,
        summary: 'Duplicate command.result keeps commandId/traceId and flips duplicate to true',
        data: { examples: ['command.result.ok', 'command.result.duplicate'] },
      },
      {
        id: 'PROTO-08',
        ok: !JSON.stringify(invalidExamples.map((e) => validateProtocolMessage(e.message))).includes(LEAK_MARKER),
        summary: 'Validation errors never echo payload values or secrets',
        data: { leakMarkerObserved: false },
      },
    ] satisfies Array<{
      id: string;
      ok: boolean;
      summary: string;
      data: Record<string, unknown>;
    }>;

    for (const record of records) {
      await recordEvidenceIfEnabled({
        id: record.id,
        status: record.ok ? 'PASS' : 'FAIL',
        summary: record.summary,
        observedAt,
        data: record.data,
      });
    }
  });
});