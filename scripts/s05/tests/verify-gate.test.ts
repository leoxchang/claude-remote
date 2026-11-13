import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  E2E_IDS,
  GateReport,
  evaluateGate,
  findAppEnvLeaks,
  findAsrIsolationViolations,
  isFunnelDisabled,
  lineCoverageFromLcov,
  parseChecklist,
  readAsr00,
} from '../verify-gate.js';

function passingReport(): GateReport {
  const e2e = new Map<string, 'PASS'>();
  for (const id of E2E_IDS) e2e.set(id, 'PASS');
  return {
    asr00: 'PASS',
    e2e,
    agentCoverage: 80,
    dartCoverage: 80,
    funnelEnabled: false,
    secrets: [],
    appEnvLeak: false,
    audioEvidence: false,
    asrIsolationViolations: [],
  };
}

describe('S05 gate', () => {
  it('passes only when every requirement is met', () => {
    expect(evaluateGate(passingReport()).passed).toBe(true);
  });

  it('fails when ASR-00 is not PASS', () => {
    const report: GateReport = { ...passingReport(), asr00: 'BLOCKED' };
    expect(evaluateGate(report).problems).toContain('ASR-00 is BLOCKED');
  });

  it('fails when any E2E is missing or not PASS', () => {
    const report = passingReport();
    const e2e = new Map(report.e2e);
    e2e.delete('E2E-03');
    e2e.set('E2E-05', 'BLOCKED');
    const result = evaluateGate({ ...report, e2e });
    expect(result.problems).toContain('E2E-03 missing from checklist');
    expect(result.problems).toContain('E2E-05 is BLOCKED');
  });

  it('fails on low coverage, secrets, leaks and raw audio', () => {
    const report: GateReport = {
      ...passingReport(),
      agentCoverage: 79.9,
      dartCoverage: 70,
      secrets: ['file:1:doubao-env-value'],
      appEnvLeak: true,
      audioEvidence: true,
      funnelEnabled: true,
    };
    const problems = evaluateGate(report).problems;
    expect(problems).toContain('agent coverage 79.9% < 80%');
    expect(problems).toContain('dart coverage 70% < 80%');
    expect(problems).toContain('Tailscale Funnel must stay disabled');
    expect(problems.some((line) => line.startsWith('secrets found'))).toBe(
      true,
    );
    expect(
      problems).toContain(
      'App contains Doubao environment variable names or X-Api-Key',
    );
    expect(problems).toContain(
      'evidence directory contains raw audio files',
    );
  });

  it('fails when ASR imports main-state modules', () => {
    const report: GateReport = {
      ...passingReport(),
      asrIsolationViolations: ['src/asr/leak.ts'],
    };
    expect(evaluateGate(report).problems).toContain(
      'ASR isolation: src/asr/leak.ts',
    );
  });

  it('parses checklist rows regardless of surrounding table syntax', () => {
    const markdown = [
      '| ID | 场景 | 状态 | 证据 |',
      '|---|---|---|---|',
      '| E2E-01 | 未配置 | PASS | trace |',
      '| E2E-02 | 权限 | BLOCKED | none |',
    ].join('\n');
    const statuses = parseChecklist(markdown);
    expect(statuses.get('E2E-01')).toBe('PASS');
    expect(statuses.get('E2E-02')).toBe('BLOCKED');
  });

  it('reads ASR-00 status conservatively', () => {
    expect(readAsr00('ASR-00: PASS')).toBe('PASS');
    expect(readAsr00('ASR-00: BLOCKED')).toBe('BLOCKED');
    expect(readAsr00('ASR-00 FAIL')).toBe('FAIL');
    expect(readAsr00('nothing here')).toBe('NOT_RUN');
  });

  it('computes line coverage from lcov', () => {
    const dir = mkdtempSync(join(tmpdir(), 's05-gate-'));
    const path = join(dir, 'lcov.info');
    writeFileSync(path, 'SF:a.ts\nDA:1,1\nDA:2,0\nDA:3,2\nend_of_record\n');
    expect(lineCoverageFromLcov(path)).toBe(66.7);
    expect(lineCoverageFromLcov(join(dir, 'missing.info'))).toBe(0);
  });

  it('detects App env leaks and ASR isolation violations', () => {
    expect(
      findAppEnvLeaks(new Map([['app.dart', "env['DOUBAO_ASR_API_KEY']"]])),
    ).toEqual(['app.dart']);
    expect(
      findAppEnvLeaks(new Map([['app.dart', 'final key = x;']])),
    ).toEqual([]);
    expect(
      findAsrIsolationViolations(
        new Map([
          [
            'asr.ts',
            "import { Journal } from '../events/durable-event-journal.js';",
          ],
        ]),
      ),
    ).toEqual(['asr.ts']);
  });

  it('requires an explicit funnelEnabled: false', () => {
    expect(isFunnelDisabled('funnelEnabled: false')).toBe(true);
    expect(isFunnelDisabled('')).toBe(false);
  });
});