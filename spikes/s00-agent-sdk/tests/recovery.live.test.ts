import { describe, expect, it } from 'vitest';

import { createScenarioContext } from '../src/evidence.js';
import { runRecoveryValidation } from '../src/scenarios/recovery.js';

describe('SDK interruption and resume (live)', () => {
  it('resumes normal and interrupted sessions and rejects an unknown session id', async () => {
    const ctx = createScenarioContext();

    const result = await runRecoveryValidation(ctx);

    expect(result.normalSessionId.length).toBeGreaterThan(0);
    expect(result.normalResumedMarker).toBe(true);
    expect(result.normalSameSession).toBe(true);
    expect(result.interrupted).toBe(true);
    expect(result.interruptOutcome).not.toBe('timeout');
    expect(result.interruptedSessionId.length).toBeGreaterThan(0);
    expect(result.interruptedResumedMarker).toBe(true);
    expect(result.invalidResumeRejected).toBe(true);
    expect(result.closed).toBe(true);
  }, 900_000);
});