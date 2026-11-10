import { describe, expect, it } from 'vitest';

import { createScenarioContext } from '../src/evidence.js';
import { runCliToSdk, runSdkToCli } from '../src/scenarios/interop.js';

describe('CLI and SDK session interoperability (live)', () => {
  it('resumes a CLI-created session from the SDK', async () => {
    const ctx = createScenarioContext();

    const result = await runCliToSdk(ctx);

    expect(result.cliSessionId.length).toBeGreaterThan(0);
    expect(result.sdkSessionId).toBe(result.cliSessionId);
    expect(result.markerRecovered).toBe(true);
    expect(result.cliExitCode).toBe(0);
  }, 900_000);

  it('resumes an SDK-created session from the CLI', async () => {
    const ctx = createScenarioContext();

    const result = await runSdkToCli(ctx);

    expect(result.sdkSessionId.length).toBeGreaterThan(0);
    expect(result.cliSessionId).toBe(result.sdkSessionId);
    expect(result.markerRecovered).toBe(true);
    expect(result.cliExitCode).toBe(0);
  }, 900_000);
});