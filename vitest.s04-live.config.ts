import { defineConfig } from 'vitest/config';

const LIVE_ENV_FLAG = 'S04_LIVE';

export default defineConfig({
  plugins: [
    {
      name: 's04-live-requires-env',
      config() {
        if (process.env[LIVE_ENV_FLAG] !== '1') {
          throw new Error(
            `FATAL: ${LIVE_ENV_FLAG}=1 is required. This suite opens real ` +
              'SQLite and calls the real SDK. Run: ' +
              `${LIVE_ENV_FLAG}=1 npm run test:s04:live`,
          );
        }
      },
    },
  ],
  test: {
    root: 'apps/agent',
    include: ['test/live/s04-real-recovery.test.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    disableConsoleIntercept: true,
    testTimeout: 600000,
    hookTimeout: 120000,
  },
});
