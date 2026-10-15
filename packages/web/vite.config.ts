/// <reference types="vitest/config" />
import { defaultClientConditions, defineConfig } from 'vite';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  base: './',
  resolve: {
    // Resolve @meshcore-web/core to its TypeScript sources (no prebuild needed).
    conditions: ['source', ...defaultClientConditions],
  },
  server: {
    port: 5180,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
