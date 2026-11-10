import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{scripts,protocol,spikes}/**/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
  },
});