import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  E2E_IDS,
  E2eStatus,
  evaluateGate,
  isFunnelDisabled,
  lineCoverageFromLcov,
  parseChecklist,
} from '../verify-gate.js';

function checklist(
  overrides: Record<string, E2eStatus> = {},
): Map<string, E2eStatus> {
  return new Map(
    E2E_IDS.map((id) => [id, overrides[id] ?? ('PASS' as E2eStatus)]),
  );
}

const healthy = {
  checklist: checklist(),
  secrets: [],
  funnelEnabled: false,
  agentCoverage: 85,
  dartCoverage: 84,
};

describe('parseChecklist', () => {
  it('reads ids and statuses from the markdown table', () => {
    const markdown = [
      '| ID | 场景 | 状态 | 证据 |',
      '|---|---|---|---|',
      '| E2E-01 | 扫码 | PASS | 2026-11-12 |',
      '| E2E-02 | 未认证拒绝 | BLOCKED | 无真机 |',
    ].join('\n');

    const statuses = parseChecklist(markdown);

    expect(statuses.get('E2E-01')).toBe('PASS');
    expect(statuses.get('E2E-02')).toBe('BLOCKED');
    expect(statuses.size).toBe(2);
  });
});

describe('evaluateGate', () => {
  it('passes when all evidence is real and thresholds are met', () => {
    expect(evaluateGate(healthy)).toEqual({ passed: true, problems: [] });
  });

  it('fails when an E2E row is missing', () => {
    const partial = checklist();
    partial.delete('E2E-07');

    const result = evaluateGate({ ...healthy, checklist: partial });

    expect(result.passed).toBe(false);
    expect(result.problems.join()).toContain('E2E-07 missing');
  });

  it('fails on any status other than PASS', () => {
    for (const status of ['FAIL', 'BLOCKED', 'NOT_RUN'] as const) {
      const result = evaluateGate({
        ...healthy,
        checklist: checklist({ 'E2E-05': status }),
      });
      expect(result.passed).toBe(false);
      expect(result.problems.join()).toContain(`E2E-05 is ${status}`);
    }
  });

  it('fails when secrets are found', () => {
    const result = evaluateGate({
      ...healthy,
      secrets: [{ file: 'a.ts', line: 3, kind: 'bearer-token' }],
    });
    expect(result.passed).toBe(false);
    expect(result.problems.join()).toContain('secrets found');
  });

  it('fails when Funnel is enabled', () => {
    const result = evaluateGate({ ...healthy, funnelEnabled: true });
    expect(result.passed).toBe(false);
    expect(result.problems.join()).toContain('Funnel');
  });

  it('fails when either coverage is below 80 percent', () => {
    expect(
      evaluateGate({ ...healthy, agentCoverage: 79.9 }).problems.join(),
    ).toContain('agent coverage');
    expect(
      evaluateGate({ ...healthy, dartCoverage: 12 }).problems.join(),
    ).toContain('dart coverage');
  });
});

describe('lineCoverageFromLcov', () => {
  it('computes line coverage from DA records', () => {
    const dir = mkdtempSync(join(tmpdir(), 's01-gate-'));
    const path = join(dir, 'lcov.info');
    writeFileSync(path, ['SF:a.ts', 'DA:1,5', 'DA:2,0', 'DA:3,1'].join('\n'));

    expect(lineCoverageFromLcov(path)).toBeCloseTo(66.7, 1);
  });

  it('returns 0 for a missing report', () => {
    expect(lineCoverageFromLcov('/nonexistent/lcov.info')).toBe(0);
  });
});

describe('isFunnelDisabled', () => {
  it('requires an explicit false', () => {
    expect(isFunnelDisabled('funnelEnabled:   false')).toBe(true);
    expect(isFunnelDisabled('funnelEnabled: true')).toBe(false);
    expect(isFunnelDisabled('nothing here')).toBe(false);
  });
});