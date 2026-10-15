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
- Don't commit unless asked by the orchestrator; never push.
- When adding a feature, also add its row/notes to `docs/roadmap.md` status if asked.
