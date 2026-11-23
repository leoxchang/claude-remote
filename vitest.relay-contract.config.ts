import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['contract-tests/relay/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});