import { describe, expect, it } from 'vitest';

import {
  E2E_IDS,
  GateReport,
  GateStatus,
  SdkEvidence,
  evaluateGate,
  hasRealSdkEvidence,
  parseChecklist,
  verifyGate,
} from '../verify-gate.js';
import { checkSecrets } from '../check-secrets.js';

interface Overrides {
  perm00?: GateStatus;
  sdkEvidence?: SdkEvidence;
  s02Gate?: GateStatus;
  e2e?: Record<string, GateStatus | 'MISSING'>;
  realDevice?: boolean;
  rollbackDocumented?: boolean;
  agentCoverage?: number;
  dartCoverage?: number;
  funnelEnabled?: boolean;
  secrets?: string[];
}

function fakeReport(overrides: Overrides = {}): GateReport {
  const e2e = new Map<string, GateStatus>(E2E_IDS.map((id) => [id, 'PASS']));
  for (const [id, status] of Object.entries(overrides.e2e ?? {})) {
    if (status === 'MISSING') e2e.delete(id);
    else e2e.set(id, status);
  }
  return {
    perm00: overrides.perm00 ?? 'PASS',
    sdkEvidence: overrides.sdkEvidence ?? 'REAL',
    s02Gate: overrides.s02Gate ?? 'PASS',
    e2e,
    realDevice: overrides.realDevice ?? true,
    rollbackDocumented: overrides.rollbackDocumented ?? true,
    agentCoverage: overrides.agentCoverage ?? 90,
    dartCoverage: overrides.dartCoverage ?? 85,
    funnelEnabled: overrides.funnelEnabled ?? false,
    secrets: overrides.secrets ?? [],
  };
}

describe('S03 verifyGate', () => {
  it('rejects mock-only or incomplete approval evidence', () => {
    expect(() => verifyGate(fakeReport({ sdkEvidence: 'MOCK' }))).toThrow(
      'real SDK',
    );
    expect(() => verifyGate(fakeReport({ sdkEvidence: 'MISSING' }))).toThrow(
      'real SDK',
    );
    expect(() =>
      verifyGate(fakeReport({ e2e: { 'E2E-08': 'BLOCKED' } })),
    ).toThrow('E2E-08');
    expect(() => verifyGate(fakeReport({ perm00: 'NOT_RUN' }))).toThrow(
      'PERM-00',
    );
  });

  it('requires the upstream S02 gate to stay valid', () => {
    expect(() => verifyGate(fakeReport({ s02Gate: 'FAIL' }))).toThrow(
      'S02 gate',
    );
  });

  it('rejects a missing E2E row, missing device or rollback steps', () => {
    expect(() =>
      verifyGate(fakeReport({ e2e: { 'E2E-03': 'MISSING' } })),
    ).toThrow('E2E-03 missing');
    expect(() => verifyGate(fakeReport({ realDevice: false }))).toThrow(
      'real device',
    );
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
    expect(() =>
      verifyGate(fakeReport({ secrets: ['a.ts:1:bearer-token'] })),
    ).toThrow('secrets');
  });

  it('passes only a complete, real report', () => {
    expect(verifyGate(fakeReport())).toBeUndefined();
    expect(evaluateGate(fakeReport()).problems).toEqual([]);
  });
});

describe('S03 evidence parsers', () => {
  it('reads the checklist statuses', () => {
    const markdown = [
      '| ID | 场景 | 状态 | 证据 |',
      '|---|---|---|---|',
      '| E2E-01 | 升级默认 deny | PASS | trace-1 |',
      '| E2E-02 | 允许一次 | NOT_RUN | - |',
    ].join('\n');

    const statuses = parseChecklist(markdown);

    expect(statuses.get('E2E-01')).toBe('PASS');
    expect(statuses.get('E2E-02')).toBe('NOT_RUN');
  });

  it('requires both REAL and PERM-00 PASS for real SDK evidence', () => {
    expect(
      hasRealSdkEvidence('sdkEvidence: REAL\nPERM-00: PASS'),
    ).toBe(true);
    expect(hasRealSdkEvidence('sdkEvidence: MOCK\nPERM-00: PASS')).toBe(false);
    expect(hasRealSdkEvidence('sdkEvidence: REAL\nPERM-00: NOT_RUN')).toBe(
      false,
    );
  });

  it('rejects leaked approval bodies, tokens and private paths', () => {
    expect(() =>
      checkSecrets('workingDirectory=/private/root command=secret token=abc'),
    ).toThrow('SECRET_DETECTED');
    expect(() => checkSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toThrow(
      'SECRET_DETECTED',
    );
    expect(() => checkSecrets('sdkEvidence: REAL')).not.toThrow();
  });
});