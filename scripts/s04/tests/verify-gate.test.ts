import { describe, expect, it } from 'vitest';

import {
  E2E_IDS,
  GateReport,
  GateStatus,
  evaluateGate,
  hasRealSdkEvidence,
  parseChecklist,
  readStore00,
  verifyGate,
} from '../verify-gate.js';
import { checkSecrets } from '../check-secrets.js';

interface Overrides {
  store00Mac?: GateStatus;
  store00Iphone?: GateStatus;
  realDataProtection?: boolean;
  sdkEvidence?: GateReport['sdkEvidence'];
  e2e?: Record<string, GateStatus | 'MISSING'>;
  agentCoverage?: number;
  dartCoverage?: number;
  funnelEnabled?: boolean;
  secrets?: string[];
}

function report(overrides: Overrides = {}): GateReport {
  const e2e = new Map<string, GateStatus>(E2E_IDS.map((id) => [id, 'PASS']));
  for (const [id, status] of Object.entries(overrides.e2e ?? {})) {
    if (status === 'MISSING') e2e.delete(id);
    else e2e.set(id, status);
  }
  return {
    store00Mac: overrides.store00Mac ?? 'PASS',
    store00Iphone: overrides.store00Iphone ?? 'PASS',
    realDataProtection: overrides.realDataProtection ?? true,
    sdkEvidence: overrides.sdkEvidence ?? 'REAL',
    e2e,
    agentCoverage: overrides.agentCoverage ?? 88,
    dartCoverage: overrides.dartCoverage ?? 81,
    funnelEnabled: overrides.funnelEnabled ?? false,
    secrets: overrides.secrets ?? [],
  };
}

describe('S04 verify gate', () => {
  it('requires STORE-00 on both platforms and real Data Protection', () => {
    expect(() => verifyGate(report({ store00Mac: 'NOT_RUN' }))).toThrow('STORE-00 Mac');
    expect(() => verifyGate(report({ store00Iphone: 'BLOCKED' }))).toThrow(
      'STORE-00 iPhone',
    );
    expect(() =>
      verifyGate(report({ realDataProtection: false })),
    ).toThrow('Data Protection');
  });

  it('rejects mock evidence, missing E2E rows and low coverage', () => {
    expect(() => verifyGate(report({ sdkEvidence: 'MOCK' }))).toThrow('real SDK');
    expect(() => verifyGate(report({ sdkEvidence: 'MISSING' }))).toThrow(
      'real SDK',
    );
    expect(() => verifyGate(report({ e2e: { 'E2E-08': 'BLOCKED' } }))).toThrow(
      'E2E-08',
    );
    expect(() => verifyGate(report({ e2e: { 'E2E-15': 'MISSING' } }))).toThrow(
      'E2E-15 missing',
    );
    expect(() => verifyGate(report({ agentCoverage: 79 }))).toThrow(
      'agent coverage',
    );
    expect(() => verifyGate(report({ dartCoverage: 79.9 }))).toThrow(
      'dart coverage',
    );
  });

  it('rejects Funnel and leaked secrets', () => {
    expect(() => verifyGate(report({ funnelEnabled: true }))).toThrow('Funnel');
    expect(() =>
      verifyGate(report({ secrets: ['a.ts:1:bearer-token'] })),
    ).toThrow('secrets');
    expect(() =>
      checkSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'),
    ).toThrow('SECRET_DETECTED');
  });

  it('passes only a complete real report', () => {
    expect(evaluateGate(report()).problems).toEqual([]);
    expect(verifyGate(report())).toBeUndefined();
  });

  it('parses the checklist and STORE-00 evidence', () => {
    const statuses = parseChecklist(
      ['| E2E-01 | 升级 | PASS | trace |', '| E2E-02 | 恢复 | NOT_RUN | - |'].join(
        '\n',
      ),
    );
    expect(statuses.get('E2E-01')).toBe('PASS');
    expect(statuses.get('E2E-02')).toBe('NOT_RUN');

    const store = readStore00(
      '**STORE-00 Mac:** PASS\nIPHONE: BLOCKED\ndataProtection: false',
    );
    expect(store).toEqual({
      mac: 'PASS',
      iphone: 'BLOCKED',
      dataProtection: false,
    });
    expect(hasRealSdkEvidence('**sdkEvidence:** REAL（PERM-00）\n**PERM-00:** PASS')).toBe(
      true,
    );
  });
});
