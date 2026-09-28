import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  include: ['packages/**/*.test.ts', 'plugins/**/*.test.ts', '.github/scripts/**/*.test.ts'],
} });
