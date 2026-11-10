import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{scripts,protocol,spikes}/**/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['scripts/s00/**/*.ts', 'protocol/v1/src/**/*.ts'],
      exclude: ['**/tests/**', 'scripts/s00/gate-cli.ts'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});