import { describe, expect, it } from 'vitest';

import {
  E2E_IDS,
  GateReport,
  GateStatus,
  evaluateGate,
  parseChecklist,
  verifyGate,
} from '../verify-gate.js';

interface Overrides {
  mocks?: GateStatus;
  conc01?: GateStatus;
  e2e?: Record<string, GateStatus | 'MISSING'>;
  realDevice?: boolean;
  rollbackDocumented?: boolean;
  agentCoverage?: number;
  dartCoverage?: number;
  funnelEnabled?: boolean;
  secrets?: string[];
}

function fakeReport(overrides: Overrides = {}): GateReport {
  const e2e = new Map<string, GateStatus>(
    E2E_IDS.map((id) => [id, 'PASS']),
  );
  for (const [id, status] of Object.entries(overrides.e2e ?? {})) {
    if (status === 'MISSING') e2e.delete(id);
    else e2e.set(id, status);
  }
  return {
    mocks: overrides.mocks ?? 'PASS',
    conc01: overrides.conc01 ?? 'PASS',
    e2e,
    realDevice: overrides.realDevice ?? true,
    rollbackDocumented: overrides.rollbackDocumented ?? true,
    agentCoverage: overrides.agentCoverage ?? 90,
    dartCoverage: overrides.dartCoverage ?? 85,
    funnelEnabled: overrides.funnelEnabled ?? false,
    secrets: overrides.secrets ?? [],
  };
}

describe('verifyGate', () => {
  it('rejects incomplete real evidence even when mocks pass', () => {
    expect(() =>
      verifyGate(fakeReport({ mocks: 'PASS', conc01: 'PASS', e2e: { 'E2E-07': 'BLOCKED' } })),
    ).toThrow('E2E-07');
    expect(() => verifyGate(fakeReport({ conc01: 'BLOCKED' }))).toThrow(
      'CONC-01',
    );
  });

  it('rejects a missing E2E row', () => {
    expect(() =>
      verifyGate(fakeReport({ e2e: { 'E2E-03': 'MISSING' } })),
    ).toThrow('E2E-03 missing');
  });

  it('rejects mocks that are not PASS', () => {
    expect(() => verifyGate(fakeReport({ mocks: 'FAIL' }))).toThrow('mocks');
  });

  it('requires the real device marker', () => {
    expect(() => verifyGate(fakeReport({ realDevice: false }))).toThrow(
      'real device',
    );
  });

  it('requires documented rollback steps', () => {
    expect(() =>
      verifyGate(fakeReport({ rollbackDocumented: false })),
    ).toThrow('rollback');
  });

  it('rejects coverage below 80% on either side', () => {
    expect(() => verifyGate(fakeReport({ agentCoverage: 79 }))).toThrow(
      'agent coverage',
    );
    expect(() => verifyGate(fakeReport({ dartCoverage: 79.9 }))).toThrow(
      'dart coverage',
    );
  });

  it('rejects Funnel and secrets', () => {
    expect(() => verifyGate(fakeReport({ funnelEnabled: true }))).toThrow(
      'Funnel',
    );
    expect(() => verifyGate(fakeReport({ secrets: ['a.ts:1:bearer-token'] }))).toThrow(
      'secrets',
    );
  });

  it('passes a complete report', () => {
    expect(verifyGate(fakeReport())).toBeUndefined();
    expect(evaluateGate(fakeReport()).problems).toEqual([]);
  });
});

describe('parseChecklist', () => {
  it('reads statuses from the markdown table', () => {
    const markdown = [
      '| ID | 场景 | 状态 | 证据 |',
      '|---|---|---|---|',
      '| E2E-01 | 双项目授权 | PASS | trace-1 |',
      '| E2E-02 | 独立上下文 | NOT_RUN | - |',
    ].join('\n');

    const statuses = parseChecklist(markdown);

    expect(statuses.get('E2E-01')).toBe('PASS');
    expect(statuses.get('E2E-02')).toBe('NOT_RUN');
    expect(statuses.size).toBe(2);
  });
});