import { describe, expect, it } from 'vitest';

import { EvidenceRecord } from '../evidence.js';
import {
  ASR_CONTRACT_IDS,
  CORE_IDS,
  evaluateS00Gate,
  findEvidenceProblems,
  recordsFromStatus,
} from '../gate.js';

const observedAt = '2026-11-10T00:00:00.000Z';

const pass = (id: string): EvidenceRecord => ({
  id,
  status: 'PASS',
  summary: '',
  observedAt,
});

const coreRecords = (): EvidenceRecord[] => CORE_IDS.map(pass);
const asrRecords = (): EvidenceRecord[] => ASR_CONTRACT_IDS.map(pass);
const deferredLive = (): EvidenceRecord => ({
  id: 'DOUBAO-LIVE',
  status: 'NOT_RUN',
  summary: 'deferred',
  observedAt: null,
  deferredTo: 'S05',
});

describe('evaluateS00Gate', () => {
  it('blocks Core when a Core id is missing', () => {
    const records = coreRecords().filter((record) => record.id !== 'SDK-05');

    const result = evaluateS00Gate(records);

    expect(result.core).toBe('BLOCKED');
    expect(result.missingCoreIds).toContain('SDK-05');
  });

  it('fails Core when any Core record failed', () => {
    const records = [
      ...coreRecords().filter((record) => record.id !== 'CLI-02'),
      { ...pass('CLI-02'), status: 'FAIL' as const },
    ];

    expect(evaluateS00Gate(records).core).toBe('FAIL');
  });

  it('blocks Core and lists limited ids', () => {
    const records = [
      ...coreRecords().filter((record) => record.id !== 'SDK-03'),
      { ...pass('SDK-03'), status: 'LIMITED' as const },
    ];

    const result = evaluateS00Gate(records);

    expect(result.core).toBe('BLOCKED');
    expect(result.limitedCoreIds).toContain('SDK-03');
  });

  it('blocks Core when a Core record is NOT_RUN', () => {
    const records = [
      ...coreRecords().filter((record) => record.id !== 'PROTO-11'),
      { ...pass('PROTO-11'), status: 'NOT_RUN' as const },
    ];

    expect(evaluateS00Gate(records).core).toBe('BLOCKED');
  });

  it('passes Core and ASR contract while ASR live stays deferred', () => {
    const result = evaluateS00Gate([
      ...coreRecords(),
      ...asrRecords(),
      deferredLive(),
    ]);

    expect(result).toEqual({
      core: 'PASS',
      asrContract: 'PASS',
      asrLive: 'DEFERRED',
      missingCoreIds: [],
      limitedCoreIds: [],
    });
  });

  it('reports ASR live PASS only when the live record passed', () => {
    const result = evaluateS00Gate([
      ...coreRecords(),
      ...asrRecords(),
      { ...pass('DOUBAO-LIVE'), observedAt },
    ]);

    expect(result.asrLive).toBe('PASS');
  });

  it('never lets the deferred live record replace a missing Core record', () => {
    const records = [
      ...coreRecords().filter((record) => record.id !== 'SDK-10'),
      ...asrRecords(),
      deferredLive(),
    ];

    const result = evaluateS00Gate(records);

    expect(result.core).toBe('BLOCKED');
    expect(result.missingCoreIds).toContain('SDK-10');
    expect(result.asrLive).toBe('DEFERRED');
  });

  it('blocks the ASR contract when a fake-contract id is missing', () => {
    const records = [
      ...coreRecords(),
      ...asrRecords().filter((record) => record.id !== 'ASR-04'),
      deferredLive(),
    ];

    expect(evaluateS00Gate(records).asrContract).toBe('BLOCKED');
  });

  it('does not treat an absent ASR live record as a compliant deferral', () => {
    const result = evaluateS00Gate([...coreRecords(), ...asrRecords()]);

    expect(result.asrLive).toBe('FAIL');
  });
});

describe('findEvidenceProblems', () => {
  const recordWithEvidence = (id: string): EvidenceRecord => ({
    ...pass(id),
    evidence: `docs/s00/evidence/${id}.json`,
  });

  it('accepts matching evidence files', () => {
    const records = [recordWithEvidence('SDK-01')];

    const problems = findEvidenceProblems(records, () => pass('SDK-01'));

    expect(problems).toEqual([]);
  });

  it('reports a missing evidence file', () => {
    const problems = findEvidenceProblems([recordWithEvidence('SDK-01')], () => {
      return undefined;
    });

    expect(problems).toEqual([
      'SDK-01: evidence file missing (docs/s00/evidence/SDK-01.json)',
    ]);
  });

  it('reports a ledger status that disagrees with the evidence file', () => {
    const problems = findEvidenceProblems(
      [recordWithEvidence('SDK-01')],
      () => ({ ...pass('SDK-01'), status: 'FAIL' }),
    );

    expect(problems).toEqual([
      'SDK-01: ledger status PASS does not match evidence FAIL',
    ]);
  });
});

describe('recordsFromStatus', () => {
  it('converts the status ledger and preserves the deferred ASR live entry', () => {
    const status = {
      'SDK-01': {
        status: 'PASS',
        summary: 'ok',
        observedAt,
        evidence: 'docs/s00/evidence/SDK-01.json',
      },
      'ASR-01': { status: 'PASS', summary: 'ok', observedAt },
      'DOUBAO-LIVE': { status: 'NOT_RUN', deferredTo: 'S05' },
    };

    const records = recordsFromStatus(status);

    expect(records).toEqual([
      {
        id: 'SDK-01',
        status: 'PASS',
        summary: 'ok',
        observedAt,
        evidence: 'docs/s00/evidence/SDK-01.json',
      },
      { id: 'ASR-01', status: 'PASS', summary: 'ok', observedAt },
      {
        id: 'DOUBAO-LIVE',
        status: 'NOT_RUN',
        summary: '',
        observedAt: null,
        deferredTo: 'S05',
      },
    ]);
  });

  it('rejects an unknown status value', () => {
    expect(() => recordsFromStatus({ 'SDK-01': { status: 'DONE' } })).toThrow(
      /status/,
    );
  });
});