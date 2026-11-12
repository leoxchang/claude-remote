import { defineConfig } from 'vitest/config';

const LIVE_ENV_FLAG = 'S01_LIVE';

export default defineConfig({
  plugins: [
    {
      name: 's01-live-requires-env',
      config() {
        if (process.env[LIVE_ENV_FLAG] !== '1') {
          throw new Error(
            `FATAL: ${LIVE_ENV_FLAG}=1 is required. These tests call the real ` +
              'SDK and incur cost. Run: ' +
              `${LIVE_ENV_FLAG}=1 npm run test:s01:live`,
          );
        }
      },
    },
  ],
  test: {
    root: 'apps/agent',
    include: ['test/live/s01-*.live.test.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 600000,
    hookTimeout: 120000,
    disableConsoleIntercept: true,
  },
});