import { defineConfig } from 'vitest/config';

const LIVE_ENV_FLAG = 'S05_LIVE';

export default defineConfig({
  plugins: [
    {
      name: 's05-live-requires-env',
      config() {
        if (process.env[LIVE_ENV_FLAG] !== '1') {
          throw new Error(
            `FATAL: ${LIVE_ENV_FLAG}=1 is required. This suite calls the ` +
              'real Doubao ASR service on a physical iPhone path. Run: ' +
              `${LIVE_ENV_FLAG}=1 npm run test:s05:live`,
          );
        }
      },
    },
  ],
  test: {
    root: 'apps/agent',
    include: ['test/live/s05-asr00-probe.test.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    disableConsoleIntercept: true,
    testTimeout: 180000,
    hookTimeout: 60000,
  },
});