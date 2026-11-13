import { defineConfig } from 'vitest/config';

const LIVE_ENV_FLAG = 'S04_LIVE';

export default defineConfig({
  plugins: [
    {
      name: 's04-store00-requires-env',
      config() {
        if (process.env[LIVE_ENV_FLAG] !== '1') {
          throw new Error(
            `FATAL: ${LIVE_ENV_FLAG}=1 is required. This gate opens real ` +
              'SQLite files. Run: ' +
              `${LIVE_ENV_FLAG}=1 npm run test:s04:store00`,
          );
        }
      },
    },
  ],
  test: {
    root: 'apps/agent',
    include: ['test/live/s04-store-gate.test.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    disableConsoleIntercept: true,
    testTimeout: 120000,
    hookTimeout: 60000,
  },
});