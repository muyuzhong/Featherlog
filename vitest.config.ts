import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  fsModuleCache: true,
  include: ['packages/**/*.test.ts', 'plugins/**/*.test.ts', 'examples/**/*.test.ts', '.github/scripts/**/*.test.ts'],
  coverage: {
    provider: 'v8',
    include: ['packages/kernel/src/**/*.ts', 'packages/shell/src/main/**/*.ts',
      'packages/shell/src/preload/**/*.ts', 'plugins/*/src/main/**/*.ts', 'examples/*/src/main/**/*.ts',
      '.github/scripts/*.mjs'],
    exclude: ['**/*.test.ts'],
    reporter: ['text', 'json-summary', 'lcov'],
    thresholds: { statements: 85, branches: 85, functions: 85, lines: 90 },
  },
} });
