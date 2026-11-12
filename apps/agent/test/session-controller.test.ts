import { describe, expect, it } from 'vitest';

import { SessionController } from '../src/session/session-controller.js';

describe('SessionController', () => {
  it('creates one session without starting a Claude query', async () => {
    const controller = new SessionController();

    const session = await controller.start('default');

    expect(session).toMatchObject({
      sessionId: expect.stringMatching(/^session_/),
      workspaceId: 'default',
      claudeSessionId: null,
      status: 'idle',
    });
  });

  it('returns the same session on repeated start', async () => {
    const controller = new SessionController();

    const first = await controller.start('default');
    const second = await controller.start('default');

    expect(second.sessionId).toBe(first.sessionId);
    expect(controller.get(first.sessionId).sessionId).toBe(first.sessionId);
  });

  it('rejects a workspace other than default', async () => {
    const controller = new SessionController();

    await expect(controller.start('other')).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_ALLOWED',
    });
  });

  it('rejects an unknown session id', () => {
    const controller = new SessionController();

    expect(() => controller.get('session_missing')).toThrow(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' }),
    );
  });

  it('returns a copy that cannot mutate the stored session', async () => {
    const controller = new SessionController();
    const session = await controller.start('default');

    session.claudeSessionId = 'mutated';

    expect(controller.get(session.sessionId).claudeSessionId).toBeNull();
  });
});