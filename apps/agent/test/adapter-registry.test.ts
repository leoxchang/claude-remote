import { describe, expect, it } from 'vitest';

import { AdapterRegistry } from '../src/adapter/adapter-registry.js';
import { ManagedRunHandle } from '../src/adapter/managed-run-driver.js';

function handle(): ManagedRunHandle {
  return {
    interrupt: async () => undefined,
    close: async () => undefined,
    resumeEvents: () => undefined,
  };
}

describe('AdapterRegistry', () => {
  it('stores and returns the handle by runId', () => {
    const registry = new AdapterRegistry();
    const first = handle();

    registry.register('run_1', 1, first);

    expect(registry.get('run_1')).toBe(first);
    expect(registry.get('run_missing')).toBeNull();
  });

  it('separates generations of the same runId', () => {
    const registry = new AdapterRegistry();
    registry.register('run_1', 1, handle());

    expect(registry.assertCurrent('run_1', 1)).toBe(true);
    expect(registry.assertCurrent('run_1', 2)).toBe(false);
    expect(registry.assertCurrent('run_missing', 1)).toBe(false);

    registry.register('run_1', 2, handle());
    expect(registry.assertCurrent('run_1', 1)).toBe(false);
    expect(registry.assertCurrent('run_1', 2)).toBe(true);
  });

  it('removes a handle and its generation', () => {
    const registry = new AdapterRegistry();
    registry.register('run_1', 1, handle());

    registry.remove('run_1');

    expect(registry.get('run_1')).toBeNull();
    expect(registry.assertCurrent('run_1', 1)).toBe(false);
  });
});