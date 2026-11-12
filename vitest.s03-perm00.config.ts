import { defineConfig } from 'vitest/config';

const LIVE_ENV_FLAG = 'S03_LIVE';

export default defineConfig({
  plugins: [
    {
      name: 's03-live-requires-env',
      config() {
        if (process.env[LIVE_ENV_FLAG] !== '1') {
          throw new Error(
            `FATAL: ${LIVE_ENV_FLAG}=1 is required. This suite calls the real ` +
              'SDK and incurs cost. Run: ' +
              `${LIVE_ENV_FLAG}=1 npm run test:s03:perm00`,
          );
        }
      },
    },
  ],
  test: {
    root: 'apps/agent',
    include: ['test/live/s03-permission-gate.test.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    disableConsoleIntercept: true,
    testTimeout: 600000,
    hookTimeout: 120000,
  },
});