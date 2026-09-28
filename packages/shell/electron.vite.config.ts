import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: { input: resolve('src/main/index.ts'), external: ['dbus-next', 'electron-updater'] },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer/app'),
    build: { rollupOptions: { input: resolve('src/renderer/app/index.html') } },
  },
});
