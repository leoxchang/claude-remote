import { describe, expect, it } from 'vitest';

import { CLI_VERSION, SDK_VERSION } from '../src/constants.js';
import { createScenarioContext } from '../src/evidence.js';
import { runSettingsValidation } from '../src/scenarios/settings.js';

describe('SDK settings validation (live)', () => {
  it('distinguishes settingSources and records versions and the gateway window', async () => {
    const ctx = createScenarioContext();

    const result = await runSettingsValidation(ctx);

    expect(result.userOnlyMarker).toBe(false);
    expect(result.defaultMarker).toBe(true);
    expect(result.explicitMarker).toBe(true);
    expect(result.versions.sdk).toBe(SDK_VERSION);
    expect(result.versions.cli).toBe(CLI_VERSION);
    expect(result.versions.runtime).toBeTruthy();
    expect(result.baselineMarker).toBe(true);
    expect(result.baselineToolNames.length).toBeGreaterThan(0);
    expect(result.probeToolUseCounts).toEqual([0, 0, 0]);
    expect(result.gatewayWindow.sessionIds.length).toBe(4);
    expect(Date.parse(result.gatewayWindow.endedAt)).toBeGreaterThanOrEqual(
      Date.parse(result.gatewayWindow.startedAt),
    );
  }, 600_000);
});