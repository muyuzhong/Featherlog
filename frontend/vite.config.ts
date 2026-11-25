import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs: the build is served from mygo://localhost/ in the app
  // and must also open from any other base.
  base: './',
  server: {
    // MyGo's devUrl points here during `mygo dev`.
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The palette tests read the stylesheets as text (?raw).
    css: true,
    restoreMocks: true,
  },
});
