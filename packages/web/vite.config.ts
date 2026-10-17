/// <reference types="vitest/config" />
import { defaultClientConditions, defineConfig } from 'vite';
import { playwright } from '@vitest/browser-playwright';
import pkg from './package.json' with { type: 'json' };

const buildDate = new Date();
const buildId = `${pkg.version}-${buildDate.getTime().toString(36)}`;

export default defineConfig({
  base: './',
  // build constants, read through src/build-info.ts
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(buildDate.toISOString()),
    __BUILD_ID__: JSON.stringify(buildId),
  },
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
    // Files run in parallel iframes: each harness scopes its IndexedDB names (see src/testing/harness.ts),
    // so tests must not touch shared origin state (localStorage etc.) outside the harness.
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
