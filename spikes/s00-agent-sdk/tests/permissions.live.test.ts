import { describe, expect, it } from 'vitest';

import { createScenarioContext } from '../src/evidence.js';
import { runPermissionValidation } from '../src/scenarios/permissions.js';

describe('SDK tool permission decisions (live)', () => {
  it('allows one Bash call and denies another without writing settings', async () => {
    const ctx = createScenarioContext();

    const result = await runPermissionValidation(ctx);

    expect(result.allow.callback).toBe(true);
    expect(result.allow.requestId).toBe(true);
    expect(result.allow.toolUseID).toBe(true);
    expect(result.allow.outputMarker).toBe(true);
    expect(result.deny.callback).toBe(true);
    expect(result.deny.outputMarker).toBe(false);
    expect(result.deny.denialObserved).toBe(true);
    expect(result.persistentSettingsWritten).toBe(false);
  }, 600_000);
});