# meshcore-web

A web-only [MeshCore](https://github.com/meshcore-dev/MeshCore) companion client.
Static site; talks to companion radios via Web Serial / Web Bluetooth and stores
state in IndexedDB.

## Layout

```
packages/
  core/   @meshcore-web/core — pure TypeScript library (protocol, crypto, storage).
          Uses only standard Web APIs (Uint8Array, DataView, TextEncoder,
          crypto.subtle, indexedDB). ESM only, built with tsc to dist/.
          Tests: vitest in Node (fake-indexeddb for IndexedDB).
  web/    @meshcore-web/web — Vite + Lit app. Imports core from source via the
          "source" export condition (no prebuild needed for dev/test).
          Tests: vitest browser mode, Playwright provider, headless Chromium.
tsconfig.base.json   shared strict compiler options
docs/                design notes
```

## Scripts (run from the repo root)

| Script              | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `npm install`       | Install all workspaces                                    |
| `npm run dev`       | Vite dev server for the web app on http://localhost:5180  |
| `npm test`          | core tests (Node) then web tests (headless Chromium)      |
| `npm run typecheck` | `tsc --noEmit` for both packages                          |
| `npm run lint`      | Alias for `typecheck` (no eslint/prettier by design)      |
| `npm run build`     | core → `packages/core/dist`, web → `packages/web/dist`    |

First-time browser test setup: `npx playwright install chromium`.

The web build uses `base: './'`, so `packages/web/dist` can be hosted from any
static path. Per-package: `npm test -w packages/core`, `npm run preview -w packages/web`, etc.
