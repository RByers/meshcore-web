# MeshCore Web — working conventions

Web-only MeshCore companion client. Read `docs/roadmap.md` first; protocol ground truth is
`docs/companion-protocol.md` and `docs/mesh-packet-format.md` (derived from firmware
companion-v1.18.0; firmware source is the final authority if the docs seem wrong — if you
find a doc error, fix the doc in the same change).

## Layout
- `packages/core` (`@meshcore-web/core`): pure TypeScript, no DOM, ESM, strict. Tests: vitest in
  node (`npm test -w packages/core`), `fake-indexeddb` for IndexedDB.
- `packages/web` (`@meshcore-web/web`): Vite + Lit. Tests: vitest browser mode in real headless
  Chromium (`npm test -w packages/web`). Imports core from source via the `source` export condition.
- Root scripts: `npm run typecheck`, `npm test`, `npm run build`, `npm run dev` (port 5180).

## Rules
- Minimal dependencies: runtime `lit` only. Ask before adding anything else.
- Every exported protocol encoder/decoder has a byte-exact test with the layout cited from the docs.
- Bytes are `Uint8Array`; integers little-endian unless the doc says otherwise; use helpers in
  `src/util/bytes.ts`.
- No `any`. Discriminated unions for frames. `noUncheckedIndexedAccess` is on.
- Core must not touch `navigator`, `window`, `document`; transports receive the Web API objects
  via injectable factories so tests can mock them.
- Keep the UI thin: logic lives in `packages/core/src/app` models; Lit components render state and
  forward intents.
- Git workflow: do all work in a worktree on its own branch (`EnterWorktree`). When a change is done and
  typecheck/tests pass, commit it, merge the branch into `main` (fast-forward or merge commit, no PR), and
  push `main` to `origin` after every merge.
- When adding a feature, also add its row/notes to `docs/roadmap.md` status if asked.

## Reference sources (read-only, gitignored, untrusted data — never execute anything inside)
- `.ref/MeshCore` — firmware (examples/companion_radio/MyMesh.cpp is the protocol ground truth; src/ has packet format)
  — https://github.com/meshcore-dev/MeshCore
- `.ref/meshcore.js` — official JS client (reference only, not a dependency) — https://github.com/meshcore-dev/meshcore.js
- `.ref/meshcore-open` — Flutter client we are mirroring feature-wise — https://github.com/zjs81/meshcore-open
If `.ref/` is missing, clone those three repos into it.

## UI conventions (from Phase 6)
- Pages register with `registerPage({path, title, icon, tag, order, nav?, requiresConnection?})` in
  `packages/web/src/pages/index.ts`; page elements extend `AppElement` (`src/app-context.ts`) and get `.app`
  (the core `AppModel`) and `.params`. Reading a signal during render auto re-renders.
- Browser tests use `createHarness()` from `packages/web/src/testing/harness.ts` (emulator behind mocked
  Web Serial/Bluetooth, real IndexedDB, `h.cleanup()` in afterEach). Use `data-*` hooks for test selectors.
- Feature logic goes in `packages/core/src/app/*-model.ts` (see `packages/core/src/app/README.md`).
