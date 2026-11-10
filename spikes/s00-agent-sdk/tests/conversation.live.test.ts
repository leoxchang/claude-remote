import { describe, expect, it } from 'vitest';

import { createScenarioContext } from '../src/evidence.js';
import { runTwoTurnConversation } from '../src/scenarios/conversation.js';

const STREAM_MARKER = 'S00_STREAM_MARKER_91C2';

describe('SDK streaming input and deltas (live)', () => {
  it('keeps one query across two turns and emits assistant text deltas', async () => {
    const ctx = createScenarioContext();

    const result = await runTwoTurnConversation(ctx);

    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(result.turnResults).toBe(2);
    expect(result.secondTurnText).toContain(STREAM_MARKER);
    expect(result.deltaCount).toBeGreaterThan(0);
    expect(result.sawAssistant).toBe(true);
  }, 600_000);
});