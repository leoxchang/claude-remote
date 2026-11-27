import { describe, expect, it, vi } from 'vitest';

import {
  ModelOption,
  ModelQueryFactory,
  ModelQueryHandle,
} from '../../src/model/model-catalog.js';
import { SdkModelCatalog } from '../../src/model/sdk-model-catalog.js';

const OPUS_ROW: ModelOption = {
  value: 'opus',
  displayName: 'Opus',
  description: '最深推理能力',
  resolvedModel: 'claude-opus-4-5',
};

const SONNET_ROW: ModelOption = {
  value: 'sonnet',
  displayName: 'Sonnet',
  description: '最佳编码模型',
};

const SDK_ROWS: ModelOption[] = [
  {
    value: 'default',
    displayName: 'Default',
    description: '跟随配置的推荐模型',
    resolvedModel: 'claude-sonnet-5',
  },
  OPUS_ROW,
  SONNET_ROW,
];

interface FakeHandle {
  handle: ModelQueryHandle;
  close: ReturnType<typeof vi.fn>;
}

function fakeHandle(rows: readonly ModelOption[]): FakeHandle {
  const close = vi.fn();
  return {
    close,
    handle: {
      supportedModels: async () => [...rows],
      close: () => close(),
    },
  };
}

function catalogWith(
  perCwd: (cwd: string) => FakeHandle,
  options: { now?: () => number; ttlMs?: number } = {},
): { catalog: SdkModelCatalog; calls: string[] } {
  const calls: string[] = [];
  const factory: ModelQueryFactory = (cwd) => {
    calls.push(cwd);
    return perCwd(cwd).handle;
  };
  return {
    catalog: new SdkModelCatalog({ queryFactory: factory, ...options }),
    calls,
  };
}

describe('SdkModelCatalog', () => {
  it('drops the default row and keeps the SDK rows', async () => {
    const fake = fakeHandle(SDK_ROWS);
    const { catalog, calls } = catalogWith(() => fake);

    const models = await catalog.list('/ws/a');

    expect(models).toEqual([OPUS_ROW, SONNET_ROW]);
    expect(calls).toEqual(['/ws/a']);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('caches per cwd', async () => {
    const fake = fakeHandle(SDK_ROWS);
    const { catalog, calls } = catalogWith(() => fake);

    await catalog.list('/ws/a');
    await catalog.list('/ws/a');

    expect(calls).toEqual(['/ws/a']);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('keeps different cwds isolated', async () => {
    const fakeA = fakeHandle([OPUS_ROW]);
    const fakeB = fakeHandle([SONNET_ROW]);
    const { catalog, calls } = catalogWith((cwd) =>
      cwd === '/ws/a' ? fakeA : fakeB,
    );

    const [a, b] = await Promise.all([
      catalog.list('/ws/a'),
      catalog.list('/ws/b'),
    ]);

    expect([...calls].sort()).toEqual(['/ws/a', '/ws/b']);
    expect(a).toEqual([OPUS_ROW]);
    expect(b).toEqual([SONNET_ROW]);
  });

  it('refetches after the ttl', async () => {
    let clock = 1_000;
    const fake = fakeHandle(SDK_ROWS);
    const { catalog, calls } = catalogWith(() => fake, {
      now: () => clock,
    });

    await catalog.list('/ws/a');
    clock += 10 * 60 * 1000;
    await catalog.list('/ws/a');
    expect(calls).toEqual(['/ws/a', '/ws/a']);
    expect(fake.close).toHaveBeenCalledTimes(2);

    clock += 10 * 60 * 1000 - 1;
    await catalog.list('/ws/a');
    expect(calls).toEqual(['/ws/a', '/ws/a']);
  });

  it('propagates factory failures', async () => {
    const { catalog } = catalogWith(() => {
      throw new Error('sdk unavailable');
    });

    await expect(catalog.list('/ws/a')).rejects.toThrow('sdk unavailable');
  });
});
