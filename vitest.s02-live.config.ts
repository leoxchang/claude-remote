import { defineConfig } from 'vitest/config';

const LIVE_ENV_FLAG = 'S02_LIVE';

export default defineConfig({
  plugins: [
    {
      name: 's02-live-requires-env',
      config() {
        if (process.env[LIVE_ENV_FLAG] !== '1') {
          throw new Error(
            `FATAL: ${LIVE_ENV_FLAG}=1 is required. These tests call the real ` +
              'SDK and incur cost. Run: ' +
              `${LIVE_ENV_FLAG}=1 npm run test:s02:concurrency`,
          );
        }
      },
    },
  ],
  test: {
    root: 'apps/agent',
    include: ['test/live/**/*.live.test.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    disableConsoleIntercept: true,
    testTimeout: 600000,
    hookTimeout: 120000,
  },
});