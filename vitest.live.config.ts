import { defineConfig } from 'vitest/config';

const LIVE_ENV_FLAG = 'S00_LIVE';

export default defineConfig({
  plugins: [
    {
      name: 's00-live-requires-env',
      config() {
        if (process.env[LIVE_ENV_FLAG] !== '1') {
          throw new Error(`${LIVE_ENV_FLAG}=1 is required to run live S00 tests`);
        }
      },
    },
  ],
  test: {
    include: ['{spikes,scripts,protocol}/**/tests/**/*.live.test.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 120000,
  },
});